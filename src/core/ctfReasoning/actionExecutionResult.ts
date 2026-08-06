/**
 * ActionExecutionResult — Phase 2.2 §二十一.
 *
 * Discriminated union of the possible outcomes from a single Action
 * execution. Replaces the old "executed / skipped / failed" boolean
 * with explicit categories so the coordinator can drive the loop
 * uniformly.
 *
 *   - executed: the action ran and produced a MaterializedResult.
 *               The Attempt is still considered pending until the
 *               coordinator applies Observation / Evidence / Artifact
 *               / Candidate events and emits ATTEMPT_COMPLETED.
 *   - skipped: the action did not run. Reason recorded for audit.
 *   - stop:    the action is a stop signal. The coordinator MUST
 *               exit the strategy loop on this cycle (no further
 *               cycles). A `stopReason` is required.
 */

import type { MaterializedResult } from './parserRegistry.js'

export interface ExecutionRefs {
  workflowRunId?: string
  oneShotRunId?: string
  agentRunId?: string
  handoffId?: string
  /** The Attempt id this execution belongs to. */
  attemptId?: string
}

export type SkipReason =
  'duplicate' | 'scope' | 'profile' | 'budget' | 'unavailable' | 'approval' | 'policy'

export type ActionExecutionResult =
  | {
      status: 'executed'
      materializedResult: MaterializedResult
      executionRefs: ExecutionRefs
      /** §七 — when the run has already projected its Observations /
       *  Evidence into TaskState via the orchestrator's projector
       *  chain, the Coordinator does NOT re-apply the drafts. */
      resultAlreadyProjected?: boolean
    }
  | {
      status: 'skipped'
      reason: SkipReason
    }
  | {
      status: 'stop'
      reason: string
      executionRefs?: ExecutionRefs
    }
  | {
      status: 'failed'
      error: { code?: string; message: string; retryable?: boolean }
      partialResult?: MaterializedResult
    }

/** Decision reached at the end of a reasoning run. */
export interface ReasoningResult {
  cycles: number
  stopped: boolean
  stopReason?: string
  selectedActionIds: string[]
  strategyDecisionIds: string[]
  finalObservationIds: string[]
  finalEvidenceIds: string[]
}

export function isExecuted(
  r: ActionExecutionResult,
): r is Extract<ActionExecutionResult, { status: 'executed' }> {
  return r.status === 'executed'
}
export function isSkipped(
  r: ActionExecutionResult,
): r is Extract<ActionExecutionResult, { status: 'skipped' }> {
  return r.status === 'skipped'
}
export function isStop(
  r: ActionExecutionResult,
): r is Extract<ActionExecutionResult, { status: 'stop' }> {
  return r.status === 'stop'
}
export function isFailed(
  r: ActionExecutionResult,
): r is Extract<ActionExecutionResult, { status: 'failed' }> {
  return r.status === 'failed'
}
