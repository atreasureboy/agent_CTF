import type OpenAI from 'openai'
import type { ModelCapabilityProfile, ModelRole } from '../modelCapability.js'

export interface ProviderAgentTurnInput {
  taskId: string
  agentRunId?: string
  role: ModelRole
  preferredModelId?: string
  messages: OpenAI.Chat.ChatCompletionMessageParam[]
  tools?: OpenAI.Chat.ChatCompletionTool[]
  temperature?: number
  maxOutputTokens?: number
  requiredCapabilities?: string[]
  signal?: AbortSignal
}

export interface ProviderStructuredInput {
  taskId: string
  agentRunId?: string
  role: ModelRole
  preferredModelId?: string
  systemPrompt?: string
  userPrompt?: string
  messages?: OpenAI.Chat.ChatCompletionMessageParam[]
  jsonSchema?: object
  schemaName?: string
  temperature?: number
  signal?: AbortSignal
}

export interface ProviderStructuredResult {
  rawText: string
  usage?: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
}

export interface ModelProvider {
  id: string

  streamAgentTurn(
    model: ModelCapabilityProfile,
    input: ProviderAgentTurnInput,
  ): Promise<AsyncIterable<OpenAI.Chat.ChatCompletionChunk>>

  executeStructured(
    model: ModelCapabilityProfile,
    input: ProviderStructuredInput,
  ): Promise<ProviderStructuredResult>
}
