/**
 * OpenAiCompatibleProvider — Tier D3 real integration.
 *
 * Talks to any OpenAI-format /v1/chat/completions endpoint:
 *   - OpenAI (api.openai.com)
 *   - Anthropic Claude (api.anthropic.com /v1/messages) — adapter
 *   - Ollama (localhost:11434)
 *   - vLLM (localhost:8000)
 *   - any other OpenAI-compatible server
 *
 * The adapter emits the action as a single `tool_choice: required`
 * tool call. The LLM's tool_calls[0].function.arguments is parsed
 * by Phase F's `validateAction` and returned as a
 * `ToolUseRequest` to the rest of the borrow chain.
 *
 * No external API key required for the test scaffold: when
 * `apiKey: ''` is passed, the adapter skips the Authorization
 * header. This is what local Ollama / vLLM typically use.
 */

import type { LlmProvider, ToolDefinition, ToolUseRequest } from './llmToolUse.js'
import { buildActionTool, buildActionPrompt } from './actionTool.js'

export interface OpenAiCompatibleConfig {
  /** Public id, e.g. 'gpt-4o' / 'claude-3-5-sonnet' / 'qwen2.5-coder'. */
  id: string
  /** API base URL, e.g. 'https://api.openai.com/v1' or
   *  'http://localhost:11434/v1'. */
  baseUrl: string
  /** Model name to send in the request body. Defaults to id. */
  model?: string
  /** Bearer token. Empty string → no Authorization header. */
  apiKey?: string
  /** HTTP timeout in ms. Default 60_000. */
  timeoutMs?: number
  /** Optional fetch override for tests. */
  fetchImpl?: typeof fetch
}

export function createOpenAiCompatibleProvider(cfg: OpenAiCompatibleConfig): LlmProvider {
  const fetchFn = cfg.fetchImpl ?? (typeof fetch !== 'undefined' ? fetch : undefined)
  if (!fetchFn) {
    throw new Error('OpenAiCompatibleProvider: no fetch available; supply fetchImpl in cfg')
  }
  const model = cfg.model ?? cfg.id
  const apiKey = cfg.apiKey ?? ''
  const timeoutMs = cfg.timeoutMs ?? 60_000
  return {
    id: cfg.id,
    async generateToolUse(
      prompt: string,
      toolDefs: ToolDefinition[],
    ): Promise<ToolUseRequest | null> {
      const actionTool = buildActionTool(toolDefs)
      const body = {
        model,
        messages: [
          { role: 'system', content: buildActionPrompt(toolDefs) },
          { role: 'user', content: prompt },
        ],
        tools: [actionTool],
        tool_choice: { type: 'function', function: { name: actionTool.function.name } },
        max_tokens: 1024,
        temperature: 0.2,
      }
      const headers: Record<string, string> = {
        'content-type': 'application/json',
      }
      if (apiKey) headers['authorization'] = `Bearer ${apiKey}`
      const controller = new AbortController()
      const timer = setTimeout(
        () => controller.abort(new Error('openai_compat_timeout')),
        timeoutMs,
      )
      let res: Response
      try {
        res = await fetchFn(`${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        })
      } finally {
        clearTimeout(timer)
      }
      if (!res.ok) {
        const text = await res.text()
        throw new Error(
          `openai_compat: HTTP ${res.status} ${res.statusText} — ${text.slice(0, 200)}`,
        )
      }
      const json = (await res.json()) as OpenAiResponse
      const choice = json.choices?.[0]
      const toolCall = choice?.message?.tool_calls?.[0]
      if (!toolCall) {
        // No tool call: LLM emitted free-form text.
        return null
      }
      const args = parseToolCallArgs(toolCall)
      return {
        id: toolCall.id,
        raw: args,
      }
    },
  }
}

interface OpenAiToolCall {
  id: string
  function: { name: string; arguments: string }
}

interface OpenAiResponse {
  choices?: Array<{
    message?: {
      content?: string
      tool_calls?: OpenAiToolCall[]
    }
  }>
}

function parseToolCallArgs(toolCall: OpenAiToolCall): unknown {
  try {
    return JSON.parse(toolCall.function.arguments)
  } catch {
    return null
  }
}
