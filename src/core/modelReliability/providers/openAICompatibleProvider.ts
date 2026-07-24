import type OpenAI from 'openai'
import type { ModelCapabilityProfile } from '../modelCapability.js'
import type {
  ModelProvider,
  ProviderAgentTurnInput,
  ProviderStructuredInput,
  ProviderStructuredResult,
} from './modelProvider.js'

export class OpenAICompatibleProvider implements ModelProvider {
  public readonly id: string
  private client: OpenAI

  constructor(client: OpenAI, id = 'openai-compatible') {
    this.client = client
    this.id = id
  }

  public async streamAgentTurn(
    modelProfile: ModelCapabilityProfile,
    input: ProviderAgentTurnInput,
  ): Promise<AsyncIterable<OpenAI.Chat.ChatCompletionChunk>> {
    const targetModel =
      modelProfile.providerModelName || modelProfile.model || input.preferredModelId || 'gpt-4o'
    return await this.client.chat.completions.create(
      {
        model: targetModel,
        messages: input.messages,
        tools: input.tools,
        tool_choice: input.tools && input.tools.length > 0 ? 'auto' : undefined,
        temperature: input.temperature ?? 0,
        max_tokens: input.maxOutputTokens ?? 8192,
        stream: true,
        stream_options: { include_usage: true },
      },
      { signal: input.signal },
    )
  }

  public async executeStructured(
    modelProfile: ModelCapabilityProfile,
    input: ProviderStructuredInput,
  ): Promise<ProviderStructuredResult> {
    const targetModel =
      modelProfile.providerModelName || modelProfile.model || input.preferredModelId || 'gpt-4o'
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = input.messages
      ? [...input.messages]
      : []

    if (input.systemPrompt) {
      messages.unshift({ role: 'system', content: input.systemPrompt })
    }
    if (input.userPrompt) {
      messages.push({ role: 'user', content: input.userPrompt })
    }

    const response = await this.client.chat.completions.create(
      {
        model: targetModel,
        messages,
        temperature: input.temperature ?? 0,
        response_format: input.jsonSchema
          ? {
              type: 'json_schema',
              json_schema: {
                name: input.schemaName ?? 'output_schema',
                schema: input.jsonSchema as Record<string, unknown>,
              },
            }
          : { type: 'json_object' },
      },
      { signal: input.signal },
    )

    const choice = response.choices?.[0]
    const content = choice?.message?.content

    if (!content && content !== '') {
      throw new Error('empty_response: OpenAI provider returned no content in message choice')
    }

    return {
      rawText: content || '',
      usage: response.usage
        ? {
            promptTokens: response.usage.prompt_tokens,
            completionTokens: response.usage.completion_tokens,
            totalTokens: response.usage.total_tokens,
          }
        : undefined,
    }
  }
}
