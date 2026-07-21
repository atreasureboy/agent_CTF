/**
 * Mock OpenAI client — drives Engine.runTurn through scripted LLM responses.
 *
 * The engine calls `client.chat.completions.create(...)` with `stream: true`
 * and iterates the returned async iterable. We synthesise chunks that look
 * like OpenAI streaming deltas so the engine's `consumeStream()` and
 * `partitionToolCalls()` pipelines can be exercised end-to-end.
 *
 * Use case: prove that Engine → ToolBroker → Tools → Findings → Handoffs is
 * fully wired and that the LLM multi-round loop converges.
 */

import type OpenAI from 'openai'

export type ScriptedAction =
  | { type: 'text'; content: string }
  | { type: 'tool_call'; toolName: string; args: object; callId?: string }
  | { type: 'finish'; reason?: 'stop' | 'tool_calls' | 'length'; usage?: { prompt: number; completion: number } }
  | { type: 'error'; message: string }
  /** Concatenated multiple actions into a single response (no separate choice). */
  | { type: 'sequence'; actions: ScriptedAction[] }

interface ScriptedTurn {
  /** Match against a simple key (parsed from user message) so we can script
   * different responses for different turns. */
  match?: (userContent: string, priorToolResults?: string[]) => boolean
  /** Even simpler match: target a specific call index (0 = first call, etc.). */
  callIndex?: number
  actions: ScriptedAction[]
}

/**
 * Helper: build a sequence of deltas that piece together a textual reply
 * + tool call. Emits chunks that look like OpenAI's ChatCompletionChunk.
 *
 * Important: when the scripted response includes tool calls, the final
 * finish_reason MUST be 'tool_calls' (not 'stop') — that's what real OpenAI
 * returns, and the engine's loop checks for it before scheduling the
 * tool-call batch.
 */
function renderTurn(actions: ScriptedAction[], callIdCounter: { i: number }): unknown[] {
  const chunks: unknown[] = []

  let hasToolCall = false
  let toolCallOrdinal = 0
  for (const action of actions) {
    if (action.type === 'tool_call') hasToolCall = true
  }

  for (const action of actions) {
    if (action.type === 'text') {
      for (const ch of action.content) {
        chunks.push({
          id: 'mock',
          choices: [{ delta: { content: ch } as Record<string, unknown> }],
        })
      }
    } else if (action.type === 'tool_call') {
      const callId = action.callId ?? `call_${callIdCounter.i++}`
      // CRITICAL: each tool_call MUST use a distinct `index`. Using a single
      // index (e.g. 0) for two tool calls causes the engine's consumer to
      // concatenate their names and arguments.
      const tcIndex = typeof action.index === 'number' ? action.index : toolCallOrdinal++
      chunks.push({
        id: 'mock',
        choices: [{
          delta: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              index: tcIndex,
              id: callId,
              type: 'function',
              function: { name: action.toolName, arguments: '' },
            }],
          } as Record<string, unknown>,
        }],
      })
      chunks.push({
        id: 'mock',
        choices: [{
          delta: {
            tool_calls: [{
              index: tcIndex,
              function: { arguments: JSON.stringify(action.args) },
            }],
          } as Record<string, unknown>,
        }],
      })
    } else if (action.type === 'finish') {
      // If the user-supplied finish reason is 'stop' but the response has
      // tool calls, override to 'tool_calls' — the engine needs it to
      // actually run the tools.
      const explicit = action.reason ?? 'stop'
      const reason = explicit === 'stop' && hasToolCall ? 'tool_calls' : explicit
      chunks.push({
        id: 'mock',
        choices: [{
          delta: {} as Record<string, unknown>,
          finish_reason: reason,
        }],
      })
      if (action.usage) {
        chunks.push({
          id: 'mock',
          choices: [],
          usage: {
            prompt_tokens: action.usage.prompt,
            completion_tokens: action.usage.completion,
            total_tokens: action.usage.prompt + action.usage.completion,
          },
        })
      }
    } else if (action.type === 'sequence') {
      chunks.push(...renderTurn(action.actions, callIdCounter))
    }
  }
  return chunks
}

export class MockOpenAIClient {
  /** Indexed by call index 0..N; each entry is a ScriptedTurn. */
  script: ScriptedTurn[] = []
  /** Fallback turn if no match fires. */
  defaultTurn: ScriptedTurn | null = null

  create(_params: unknown, _options?: unknown): unknown {
    // The shape matches `AsyncIterable<ChatCompletionChunk>` so the engine's
    // consumeStream can iterate it.
    const counter = { i: 0 }
    const _self = this
    return {
      [Symbol.asyncIterator]() {
        let consumed = false
        let idx = 0
        return {
          async next(): Promise<{ value: unknown; done: boolean }> {
            // We synthesise one turn at a time, freezing stream consumption
            // until the caller iterates a chunk (which the engine does in its
            // own async loop).
            if (consumed) return { value: undefined as unknown, done: true }
            const turn = _self._pickTurn(idx)
            const chunks = renderTurn(turn.actions, counter)
            consumed = true
            return {
              value: chunks[idx] ?? {
                id: 'mock',
                choices: [{ delta: {} as Record<string, unknown>, finish_reason: 'stop' }],
              },
              done: false,
            }
          },
        }
      },
    }
    // The engine expects an iterable that yields multiple chunks. The shape
    // above only returns one chunk per call to .next(); we instead expose
    // the full chunk list via a streaming fake.

    // Return a real Promise-wrapped iterable that yields chunks incrementally.
  }

  /** Internal: pick which scripted turn applies. Default to script[i] or last. */
  private _pickTurn(i: number): ScriptedTurn {
    if (i < this.script.length) return this.script[i]
    return this.defaultTurn ?? this.script[this.script.length - 1]
  }
}

/**
 * Better implementation: yields all chunks of the scripted turn as an
 * AsyncIterable. The engine iterates with for-await.
 */
export class ScriptedClient {
  /** Number of times `create()` has been invoked so far. */
  callCount = 0
  script: ScriptedTurn[] = []
  defaultTurn: ScriptedTurn = {
    actions: [{ type: 'finish', reason: 'stop' }],
  }
  /** Recorded conversations seen by the engine (debug + assertions). */
  readonly log: { turn: number; userMessage: string; emitted: string }[] = []

  chat: unknown = undefined  // assigned below

  constructor() {
    this.chat = {
      completions: {
        create: async (
          params: { messages?: unknown[] },
          _options?: unknown,
        ): Promise<AsyncIterable<unknown>> => {
          const counter = { i: 0 }
          const thisCall = this.callCount++
          const userMsgs = (params.messages ?? []).filter((m: unknown) =>
            (m as { role?: string })?.role === 'user',
          )
          const lastUser = userMsgs[userMsgs.length - 1] as { content?: unknown } | undefined
          const userContent = typeof lastUser?.content === 'string' ? lastUser.content : ''

          this.log.push({ turn: thisCall, userMessage: userContent.slice(0, 200), emitted: '' })

          const turn = this._pickTurn(userContent, thisCall)
          const chunks = renderTurn(turn.actions, counter)
          return this._asyncIterable(chunks)
        },
      },
    }
  }

  private _pickTurn(userContent: string, thisCall = 0): ScriptedTurn {
    // Prefer a script entry whose top-level `callIndex` matches `thisCall`.
    for (const t of this.script) {
      if (typeof t.callIndex === 'number' && t.callIndex === thisCall) return t
    }
    // Otherwise fall back to the predicate-based match.
    for (const t of this.script) {
      if (!t.match) continue
      if (t.match(userContent, this.log.flatMap((l) => [l.emitted]))) return t
    }
    return this.defaultTurn
  }

  private async *_asyncIterable(chunks: unknown[]): AsyncGenerator<unknown> {
    for (const c of chunks) {
      yield c
    }
  }
}
