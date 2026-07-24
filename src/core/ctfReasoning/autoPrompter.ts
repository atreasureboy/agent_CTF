/**
 * AutoPrompter — Phase borrow-plan Tier B1 (NYU D-CIPHER pattern).
 *
 * NYU's D-CIPHER runs a separate LLM (the "auto-prompter") *before*
 * the planner/executor pair starts. The auto-prompter generates a
 * challenge-aware initial user prompt that frames the planner with
 * category-specific guidance (e.g. "this is a `crypto` challenge,
 * look for modular arithmetic in the encrypted blob" or "this is a
 * `pwn` challenge, run checksec first").
 *
 * In our deterministic-planner architecture, AutoPrompter is an
 * adapter that:
 *   1. Receives the original input (suggestedActions, runContext).
 *   2. Calls an LLM (configurable; we ship a deterministic
 *      template-based fallback for tests).
 *   3. Returns a rewritten `ProcessReasoningInputsInput` with an
 *      `autoPromptNotes` field that the Coordinator can log.
 *
 * AutoPrompter is optional — the Coordinator calls it only if the
 * caller's `ProcessReasoningInputsInput.cascade` includes
 * `autoPrompt: true`. The Adapter is pure: a MockAutoPrompter is
 * provided for tests.
 */

import type { SuggestedAction } from './suggestedAction.js'
import type { ChallengeCategory } from '../toolBroker/categoryToolset.js'

export interface AutoPromptInput {
  taskId: string
  category: ChallengeCategory
  rawPrompt: string
  /** The original suggested actions, so the AutoPrompter can frame
   *  them. */
  suggestedActions: ReadonlyArray<SuggestedAction>
  /** Optional historical context. */
  history?: ReadonlyArray<{ at: number; kind: string; summary: string }>
}

export interface AutoPromptOutput {
  /** LLM-generated task framing (e.g. "Start with `binwalk -e` to
   *  extract embedded files; check `strings` for printable
   *  credentials"). */
  framing: string
  /** Optional list of suggested initial actions to queue ahead of
   *  the planner. */
  primingActions?: SuggestedAction[]
  /** Free-form notes the Coordinator may surface to the operator
   *  audit log. */
  notes?: string
}

export interface AutoPrompter {
  /** LLM-driven adapter. May be slow; the Coordinator awaits. */
  generate(input: AutoPromptInput): Promise<AutoPromptOutput>
}

/** Deterministic AutoPrompter used in tests / dry-run. Builds a
 *  category-aware framing from a template, no LLM call. */
export class TemplateAutoPrompter implements AutoPrompter {
  generate(input: AutoPromptInput): Promise<AutoPromptOutput> {
    const framing = buildFraming(input.category, input.suggestedActions)
    return Promise.resolve({
      framing,
      notes: `auto-prompt: template-driven; category=${input.category}; actions=${input.suggestedActions.length}`,
    })
  }
}

function buildFraming(
  category: ChallengeCategory,
  actions: ReadonlyArray<SuggestedAction>,
): string {
  const base = `Category: ${category}. `
  const types = actions.map((a) => a.type).join(', ')
  switch (category) {
    case 'crypto':
      return (
        base +
        'Look for known primitives (RSA / AES / ChaCha / XOR). ' +
        'Try small-exponent / small-message attacks first. ' +
        `Suggested actions in this cycle: ${types}.`
      )
    case 'pwn':
      return (
        base +
        'Run checksec first. ' +
        'Look for stack / heap / format-string / UAF. ' +
        'Capture the binary and the libc. ' +
        `Suggested actions: ${types}.`
      )
    case 'web':
      return (
        base +
        'Inspect cookies, headers, and path parameters. ' +
        'Try common XSS / SQLi / path-traversal / IDOR. ' +
        `Suggested actions: ${types}.`
      )
    case 'reverse':
      return (
        base +
        'Run `file` and `strings` first. ' +
        'Decompile with Ghidra / radare2. ' +
        `Suggested actions: ${types}.`
      )
    case 'misc':
    default:
      return base + 'No category-specific heuristics. ' + `Suggested actions: ${types}.`
  }
}

/** Optional pipeline: an AutoPrompter + a structured-output schema
 *  so the Coordinator can validate the framing before applying it. */
export async function safeGenerate(
  prompter: AutoPrompter,
  input: AutoPromptInput,
): Promise<AutoPromptOutput | undefined> {
  try {
    return await prompter.generate(input)
  } catch {
    return undefined
  }
}
