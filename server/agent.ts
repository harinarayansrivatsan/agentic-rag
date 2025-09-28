// Import required modules from LangChain ecosystem
import { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai"
import { ChatGoogleGenerativeAI } from "@langchain/google-genai"
import { AIMessage, BaseMessage, HumanMessage } from "@langchain/core/messages"
import {
  ChatPromptTemplate,
  MessagesPlaceholder,
} from "@langchain/core/prompts"
import { StateGraph, Annotation } from "@langchain/langgraph"
import { DynamicTool } from "@langchain/core/tools"
import { ToolNode } from "@langchain/langgraph/prebuilt"
import { MongoDBSaver } from "@langchain/langgraph-checkpoint-mongodb"
import { MongoDBAtlasVectorSearch } from "@langchain/mongodb"
import { MongoClient } from "mongodb"
import { z } from "zod"
import "dotenv/config"

// State interface
interface AgentState {
  messages: BaseMessage[]
}

// Utility function to handle API rate limits with exponential backoff
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries = 3
): Promise<T> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (error: any) {
      if (error.status === 429 && attempt < maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 30000)
        console.log(`Rate limit hit. Retrying in ${delay/1000} seconds...`)
        await new Promise(resolve => setTimeout(resolve, delay))
        continue
      }
      throw error
    }
  }
  throw new Error("Max retries exceeded")
}

// Main function that creates and runs the AI agent
export async function callAgent(client: MongoClient, query: string, thread_id: string) {
  try {
    // Database configuration
    const dbName = "inventory_database"
    const db = client.db(dbName)
    const collection = db.collection("items")

    // Define the state structure for the agent workflow
    const GraphState = Annotation.Root({
      messages: Annotation<BaseMessage[]>({
        reducer: (x: BaseMessage[], y: BaseMessage[]) => x.concat(y),
      }),
    })

    // Create a custom tool for searching furniture inventory using DynamicTool
    const itemLookupTool = new DynamicTool({
      name: "item_lookup",
      description: "Gathers furniture item details from the Inventory database. Input should be a JSON string with 'query' (required string) and optional 'n' (number of results, default 10).",
      func: async (toolInput: string) => {
        try {
          // Parse the input to extract query and n
          const input = JSON.parse(toolInput)
          const { query, n = 10 } = input

          console.log("Item lookup tool called with query:", query)

          // Check if database has any data at all
          const totalCount = await collection.countDocuments()
          console.log(`Total documents in collection: ${totalCount}`)

          if (totalCount === 0) {
            console.log("Collection is empty")
            return JSON.stringify({
              error: "No items found in inventory",
              message: "The inventory database appears to be empty",
              count: 0
            })
          }

          // Get sample documents for debugging purposes
          const sampleDocs = await collection.find({}).limit(3).toArray()
          console.log("Sample documents:", sampleDocs)

          // Configuration for MongoDB Atlas Vector Search
          const dbConfig = {
            collection: collection,
            indexName: "vector_index",
            textKey: "embedding_text",
            embeddingKey: "embedding",
          }

          // Create vector store instance for semantic search using Google Gemini embeddings
          const vectorStore = new MongoDBAtlasVectorSearch(
            new GoogleGenerativeAIEmbeddings({
              apiKey: process.env.GOOGLE_API_KEY,
              model: "text-embedding-004",
            }),
            dbConfig
          )

          console.log("Performing vector search...")
          // Perform semantic search using vector embeddings
          const result = await vectorStore.similaritySearchWithScore(query, n)
          console.log(`Vector search returned ${result.length} results`)

          // If vector search returns no results, fall back to text search
          if (result.length === 0) {
            console.log("Vector search returned no results, trying text search...")
            const textResults = await collection.find({
              $or: [
                { item_name: { $regex: query, $options: 'i' } },
                { item_description: { $regex: query, $options: 'i' } },
                { categories: { $regex: query, $options: 'i' } },
                { embedding_text: { $regex: query, $options: 'i' } }
              ]
            }).limit(n).toArray()

            console.log(`Text search returned ${textResults.length} results`)
            return JSON.stringify({
              results: textResults,
              searchType: "text",
              query: query,
              count: textResults.length
            })
          }

          return JSON.stringify({
            results: result,
            searchType: "vector",
            query: query,
            count: result.length
          })

        } catch (error: any) {
          console.error("Error in item lookup:", error)
          return JSON.stringify({
            error: "Failed to search inventory",
            details: error.message,
            query: toolInput
          })
        }
      },
    })

    // Array of all available tools
    const tools = [itemLookupTool]
    const toolNode = new ToolNode(tools)

    // Initialize the AI model (Google's Gemini)
    const model = new ChatGoogleGenerativeAI({
      model: "gemini-2.0-flash",
      temperature: 0,
      maxRetries: 0,
      apiKey: process.env.GOOGLE_API_KEY,
    }).bindTools(tools)

    // Decision function: determines next step in the workflow
    function shouldContinue(state: AgentState): string {
      const messages = state.messages
      const lastMessage = messages[messages.length - 1] as AIMessage

      if (lastMessage.tool_calls?.length) {
        return "tools"
      }
      return "__end__"
    }

    // Function that calls the AI model with retry logic
    async function callModel(state: AgentState) {
      return retryWithBackoff(async () => {
        const prompt = ChatPromptTemplate.fromMessages([
          [
            "system",
            `You are a helpful E-commerce Chatbot Agent for a furniture store.

IMPORTANT: You have access to an item_lookup tool that searches the furniture inventory database. ALWAYS use this tool when customers ask about furniture items, even if the tool returns errors or empty results.

When using the item_lookup tool:
- If it returns results, provide helpful details about the furniture items
- If it returns an error or no results, acknowledge this and offer to help in other ways
- If the database appears to be empty, let the customer know that inventory might be being updated

Current time: {time}`,
          ],
          new MessagesPlaceholder("messages"),
        ])

        const formattedPrompt = await prompt.formatMessages({
          time: new Date().toISOString(),
          messages: state.messages,
        })

        const result = await model.invoke(formattedPrompt)
        return { messages: [result] }
      })
    }

    // Build the workflow graph
    const workflow = new StateGraph(GraphState)
      .addNode("agent", callModel)
      .addNode("tools", toolNode)
      .addEdge("__start__", "agent")
      .addConditionalEdges("agent", shouldContinue)
      .addEdge("tools", "agent")

    // Initialize conversation state persistence
    const checkpointer = new MongoDBSaver({ client, dbName })
    const app = workflow.compile({ checkpointer })

    // Execute the workflow with proper state management for conversation history
    const config = { configurable: { thread_id: thread_id }, recursionLimit: 15 }

    // For continuing conversations, we need to get existing state and add new message
    // For new conversations, we start fresh
    let initialState
    try {
      // Try to get existing state first
      console.log(`Getting state for thread_id: ${thread_id}`)
      const currentState = await app.getState(config)
      console.log("Current state:", currentState ? "Found" : "Not found")

      if (currentState && currentState.values && currentState.values.messages) {
        console.log(`Found ${currentState.values.messages.length} existing messages`)
        // Add new message to existing conversation
        initialState = {
          messages: [...currentState.values.messages, new HumanMessage(query)]
        }
        console.log(`Total messages after adding new one: ${initialState.messages.length}`)
      } else {
        console.log("Starting new conversation")
        // Start new conversation
        initialState = {
          messages: [new HumanMessage(query)]
        }
      }
    } catch (error) {
      console.log("Error getting state, starting fresh:", error)
      // If getting state fails, start fresh (new conversation)
      initialState = {
        messages: [new HumanMessage(query)]
      }
    }

    const finalState = await app.invoke(initialState, config)

    const response = finalState.messages[finalState.messages.length - 1].content
    console.log("Agent response:", response)

    return response

  } catch (error: any) {
    console.error("Error in callAgent:", error.message)

    if (error.status === 429) {
      throw new Error("Service temporarily unavailable due to rate limits. Please try again in a minute.")
    } else if (error.status === 503) {
      throw new Error("Google Gemini API is currently overloaded. Please try again in a few moments.")
    } else if (error.status === 401) {
      throw new Error("Authentication failed. Please check your API configuration.")
    } else {
      throw new Error(`Agent failed: ${error.message}`)
    }
  }
}