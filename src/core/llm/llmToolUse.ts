/**
 * LLM tool-use protocol — Phase borrow-plan Tier D3.
 *
 * Inspired by CAI's `AgentOutputSchema` (Pydantic-based), swe-agent's
 * `JsonParser`, and CHYing's structured XML prompt compiler.
 *
 * The protocol:
 *   1. Caller declares the LLM's role + tools (per `RoleVisibilityMap`).
 *   2. LLM provider adapter sends a prompt, receives a
 *      `ToolUseRequest` listing the structured action the LLM wants.
 *   3. Caller validates the request against the `ActionSchema`
 *      (Phase F). If valid, the action is dispatched. If invalid,
 *      a `LlmToolUseResult.invalid` is returned with error details.
 *
 * Provider-agnostic: Claude uses `tool_use`, OpenAI uses `tools`
 * + `tool_calls`. We expose a single `LlmProvider` interface; the
 * concrete `ClaudeProvider` / `OpenAiProvider` are out of scope
 * (the test bench uses `MockProvider`).
 *
 * Pure: this module does no I/O, no LLM call. The provider
 * adapter is the only side-effecting piece.
 */

import type { SuggestedAction } from '../ctfReasoning/suggestedAction.js'
import { validateAction, formatValidationErrors } from '../ctfReasoning/actionSchema.js'

export interface ToolUseRequest {
  /** Stable id from the LLM provider. */
  id: string
  /** Raw JSON the LLM emitted for the action. */
  raw: unknown
}

export interface LlmProvider {
  /** Provider id, e.g. 'claude-3-5-sonnet' / 'gpt-4o'. */
  readonly id: string
  /** Send a prompt and return a structured ToolUseRequest. May
   *  return null when the LLM emits free-form text instead of a
   *  tool call. */
  generateToolUse(prompt: string, toolDefs: ToolDefinition[]): Promise<ToolUseRequest | null>
}

export interface ToolDefinition {
  name: string
  description: string
  /** JSON Schema for the LLM's tool input. */
  inputSchema: unknown
}

export type LlmToolUseResult =
  | { kind: 'ok'; action: SuggestedAction; toolUseRequestId: string }
  | { kind: 'invalid'; errors: string[]; toolUseRequestId: string }
  | { kind: 'no-tool-call'; reason: 'free_text'; toolUseRequestId?: undefined }

/** Drive an LLM provider, validate the emitted action, dispatch. */
export async function askLlmForAction(
  provider: LlmProvider,
  prompt: string,
  toolDefs: ToolDefinition[],
): Promise<LlmToolUseResult> {
  const req = await provider.generateToolUse(prompt, toolDefs)
  if (!req) return { kind: 'no-tool-call', reason: 'free_text' }
  const v = validateAction(req.raw)
  if (v.ok) {
    return { kind: 'ok', action: v.value, toolUseRequestId: req.id }
  }
  return { kind: 'invalid', errors: [formatValidationErrors(v.errors)], toolUseRequestId: req.id }
}

/** Mock provider used in tests: a `MockLlmProvider` whose response
 *  is set imperatively. */
export class MockLlmProvider implements LlmProvider {
  readonly id: string
  private next: ToolUseRequest | null
  constructor(id: string, initial: ToolUseRequest | null = null) {
    this.id = id
    this.next = initial
  }
  setNext(req: ToolUseRequest | null): void {
    this.next = req
  }
  async generateToolUse(_prompt: string, _defs: ToolDefinition[]): Promise<ToolUseRequest | null> {
    return this.next
  }
}
