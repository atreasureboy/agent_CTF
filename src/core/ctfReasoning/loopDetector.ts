/**
 * LoopDetector — Phase borrow-plan Phase A3.
 *
 * Inspired by ctf-agent (Veria): a sliding 12-call window keyed on
 * `(action.type, action.input fingerprint)`. After 5 repeated calls
 * the planner rejects with reason `repeated_action_exhausted`.
 *
 * The window state lives in TaskState; this module is pure.
 */

import { createAttemptFingerprint } from '../ctfReasoning/attemptFingerprint.js'
import type { SuggestedAction } from './suggestedAction.js'

export const LOOP_DETECTOR_WINDOW_SIZE = 12
export const LOOP_DETECTOR_REPEAT_LIMIT = 5
/** Phase A4 — CVE-id-aware short circuit. */
export const LOOP_DETECTOR_CVE_LIMIT = 3
/** Phase A4 — regex for CVE / GHSA / OSVDB ids. */
export const CVE_ID_RE = /\b(?:CVE-\d{4}-\d{4,}|GHSA-[a-z0-9-]+|OSVDB-\d+)\b/i

export interface LoopDetectorEntry {
  fingerprint: string
  actionType: SuggestedAction['type']
  targetId: string
  at: number
  /** Phase A4 — if the action referenced a CVE/GHSA/OSVDB id, the
   *  id is stored here. The detector matches on (id) to short-circuit
   *  CVE loops faster than the global limit. */
  cveId?: string
}

export interface LoopDetectorVerdict {
  repeated: boolean
  count: number
  fingerprint?: string
  /** Phase A4 — when the action references a known CVE, a separate
   *  short-circuit fires. */
  cveId?: string
  cveRepeated?: boolean
}

/** Inspect the recent history and decide whether `candidate` would be
 *  the 6th (default) identical occurrence. */
export function checkRepeat(
  history: ReadonlyArray<LoopDetectorEntry>,
  candidate: SuggestedAction,
  now: number,
  opts: { windowSize?: number; repeatLimit?: number; cveLimit?: number } = {},
): LoopDetectorVerdict {
  const fp = fingerprintOf(candidate)
  const cveLimit = opts.cveLimit ?? LOOP_DETECTOR_CVE_LIMIT
  const limit = opts.repeatLimit ?? LOOP_DETECTOR_REPEAT_LIMIT
  const cutoff = now - 60 * 60 * 1000 // last hour
  const recent = history.filter((h) => h.at >= cutoff).slice(-LOOP_DETECTOR_WINDOW_SIZE)
  const count = recent.filter((h) => h.fingerprint === fp).length
  const base = {
    repeated: count >= limit,
    count,
    fingerprint: count > 0 ? fp : undefined,
  }
  // Phase A4 — CVE-aware short circuit. If the candidate references
  // a CVE / GHSA / OSVDB id, count those separately and short-circuit
  // at `cveLimit` repeats.
  const cveId = extractCveId(candidate)
  if (cveId) {
    const cveCount = recent.filter((h) => extractCveIdFromEntry(h) === cveId).length
    return { ...base, cveId, cveRepeated: cveCount >= cveLimit }
  }
  return base
}

function extractCveId(action: SuggestedAction): string | undefined {
  const blob =
    action.type === 'call_tool'
      ? inputToStringForLoop(action.input)
      : action.type === 'request_handoff'
        ? inputToStringForLoop({ objective: action.objective })
        : action.type === 'run_workflow'
          ? inputToStringForLoop(action.inputs)
          : action.type === 'verify_flag'
            ? inputToStringForLoop({ candidateId: action.candidateId })
            : action.type === 'run_oneshot'
              ? inputToStringForLoop({ options: action.options ?? {} })
              : ''
  const m = blob.match(CVE_ID_RE)
  return m?.[0]?.toUpperCase()
}

function extractCveIdFromEntry(entry: LoopDetectorEntry): string | undefined {
  return entry.cveId
}

function inputToStringForLoop(input: unknown): string {
  if (input === null || input === undefined) return ''
  if (typeof input === 'string') return input
  try {
    return JSON.stringify(input)
  } catch {
    return ''
  }
}

function fingerprintOf(action: SuggestedAction): string {
  const kind: 'oneshot' | 'workflow' | 'tool' | 'handoff' | 'verification' | 'manual' =
    action.type === 'run_oneshot'
      ? 'oneshot'
      : action.type === 'run_workflow'
        ? 'workflow'
        : action.type === 'call_tool'
          ? 'tool'
          : action.type === 'request_handoff'
            ? 'handoff'
            : action.type === 'verify_flag'
              ? 'verification'
              : 'manual'
  const targetId =
    action.type === 'run_oneshot'
      ? action.manifestId
      : action.type === 'run_workflow'
        ? action.workflowId
        : action.type === 'call_tool'
          ? action.toolId
          : action.type === 'request_handoff'
            ? action.capability
            : action.type === 'verify_flag'
              ? action.candidateId
              : 'stop'
  // Use the canonical AttemptFingerprint path so the planner's
  // dedup and the loop detector share one canonical identifier.
  return createAttemptFingerprint({
    kind,
    targetId,
    parameters: (action as unknown as { input?: Record<string, unknown> }).input ?? {},
  })
}

export function fingerprintForHistory(action: SuggestedAction, at: number): LoopDetectorEntry {
  const targetId =
    action.type === 'run_oneshot'
      ? action.manifestId
      : action.type === 'run_workflow'
        ? action.workflowId
        : action.type === 'call_tool'
          ? action.toolId
          : action.type === 'request_handoff'
            ? action.capability
            : action.type === 'verify_flag'
              ? action.candidateId
              : 'stop'
  return {
    fingerprint: fingerprintOf(action),
    actionType: action.type,
    targetId,
    at,
    cveId: extractCveId(action),
  }
}
