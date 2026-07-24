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

export interface LoopDetectorEntry {
  fingerprint: string
  actionType: SuggestedAction['type']
  targetId: string
  at: number
}

export interface LoopDetectorVerdict {
  repeated: boolean
  count: number
  fingerprint?: string
}

/** Inspect the recent history and decide whether `candidate` would be
 *  the 6th (default) identical occurrence. */
export function checkRepeat(
  history: ReadonlyArray<LoopDetectorEntry>,
  candidate: SuggestedAction,
  now: number,
  opts: { windowSize?: number; repeatLimit?: number } = {},
): LoopDetectorVerdict {
  const fp = fingerprintOf(candidate)
  const cutoff = now - 60 * 60 * 1000 // last hour
  const recent = history.filter((h) => h.at >= cutoff).slice(-LOOP_DETECTOR_WINDOW_SIZE)
  const count = recent.filter((h) => h.fingerprint === fp).length
  const limit = opts.repeatLimit ?? LOOP_DETECTOR_REPEAT_LIMIT
  return {
    repeated: count >= limit,
    count,
    fingerprint: count > 0 ? fp : undefined,
  }
}

function fingerprintOf(action: SuggestedAction): string {
  const kind: 'oneshot' | 'workflow' | 'tool' | 'handoff' | 'verification' | 'manual' =
    action.type === 'run_oneshot' ? 'oneshot' :
    action.type === 'run_workflow' ? 'workflow' :
    action.type === 'call_tool' ? 'tool' :
    action.type === 'request_handoff' ? 'handoff' :
    action.type === 'verify_flag' ? 'verification' :
    'manual'
  const targetId =
    action.type === 'run_oneshot' ? action.manifestId :
    action.type === 'run_workflow' ? action.workflowId :
    action.type === 'call_tool' ? action.toolId :
    action.type === 'request_handoff' ? action.capability :
    action.type === 'verify_flag' ? action.candidateId :
    'stop'
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
    action.type === 'run_oneshot' ? action.manifestId :
    action.type === 'run_workflow' ? action.workflowId :
    action.type === 'call_tool' ? action.toolId :
    action.type === 'request_handoff' ? action.capability :
    action.type === 'verify_flag' ? action.candidateId :
    'stop'
  return {
    fingerprint: fingerprintOf(action),
    actionType: action.type,
    targetId,
    at,
  }
}