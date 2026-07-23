/**
 * MaterializationContext — Phase 2.2 §六.
 *
 * Carries the attempt id + run context so every Observation / Evidence
 * / Artifact / FlagCandidate draft produced by a Materializer is
 * automatically bound to its Attempt.
 */

import type { MaterializedResult } from './parserRegistry.js'

export interface MaterializationContext {
  taskId: string
  attemptId: string
  producerId: string
  agentRunId?: string
  workflowRunId?: string
  stepId?: string
  oneShotRunId?: string
  handoffId?: string
}

export function createMaterializationContext(init: Omit<MaterializationContext, 'producerId'> & { producerId?: string }): MaterializationContext {
  return {
    taskId: init.taskId,
    attemptId: init.attemptId,
    producerId: init.producerId ?? 'unknown',
    agentRunId: init.agentRunId,
    workflowRunId: init.workflowRunId,
    stepId: init.stepId,
    oneShotRunId: init.oneShotRunId,
    handoffId: init.handoffId,
  }
}

/** Stamp the attempt id onto every draft. Observations / Evidence /
 *  FlagCandidateDraft do not currently carry an attemptId field; the
 *  bind happens at the store reducer level via separate events. */
export function attachAttemptToDrafts(
  result: MaterializedResult,
  attemptId: string,
): MaterializedResult {
  // The drafts are intentionally not enriched here — the reducer-side
  // ATTEMPT_COMPLETED event is the authoritative place where Attempt
  // → produced id bindings are written.
  void attemptId
  return result
}