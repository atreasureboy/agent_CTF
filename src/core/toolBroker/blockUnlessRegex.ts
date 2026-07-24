/**
 * BlockUnlessRegex — Phase borrow-plan Tier A3 (swe-agent pattern).
 *
 * Inspired by swe-agent v0.7's `block_unless_regex`:
 *   block_unless_regex = {'radare2': r'\b(?:radare2)\b.*\s+-c\s+.*'}
 *
 * `radare2` is blocked outright, but `radare2 -c "..."` is allowed.
 * This is a small but elegant way to express "this binary only makes
 * sense with a subcommand".
 *
 * Pure: takes a toolId + an input object, returns a decision.
 */

export interface BlockUnlessRegexConfig {
  /** Map from toolId to a regex that the call's input string
   *  representation MUST match. */
  blockUnlessRegex: Record<string, RegExp>
}

/** Convert a tool-call input object to a flat string for regex
 *  matching. JSON.stringify gives us a stable, deterministic
 *  representation. */
export function inputToString(input: unknown): string {
  if (input === null || input === undefined) return ''
  if (typeof input === 'string') return input
  try {
    return JSON.stringify(input)
  } catch {
    return String(input)
  }
}

export interface BlockUnlessRegexResult {
  allowed: boolean
  reason?: 'block_unless_regex_failed' | 'no_rule' | 'matched'
  rule?: RegExp
}

export function checkBlockUnlessRegex(
  config: BlockUnlessRegexConfig,
  toolId: string,
  input: unknown,
): BlockUnlessRegexResult {
  const rule = config.blockUnlessRegex[toolId]
  if (!rule) {
    return { allowed: true, reason: 'no_rule' }
  }
  const haystack = inputToString(input)
  if (rule.test(haystack)) {
    return { allowed: true, reason: 'matched', rule }
  }
  return { allowed: false, reason: 'block_unless_regex_failed', rule }
}

/** Build a default config from a list of (toolId, regex) pairs. */
export function buildBlockUnlessRegex(
  rules: ReadonlyArray<[string, RegExp]>,
): BlockUnlessRegexConfig {
  const out: Record<string, RegExp> = {}
  for (const [tool, re] of rules) {
    out[tool] = re
  }
  return { blockUnlessRegex: out }
}
