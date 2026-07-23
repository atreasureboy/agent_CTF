/**
 * StrategyActionExecutor — Phase 2.2 §二十.
 *
 * The ReasoningCoordinator does NOT know how to execute a tool /
 * workflow / oneShot / specialist — it only knows how to drive the
 * strategy loop. Concrete execution is delegated to an
 * `StrategyActionExecutor` adapter that handles the per-action-type
 * routing.
 *
 * Coordinator contract:
 *   1. Resolve the candidate SuggestedAction into a CTFAttempt
 *      (kind, targetId, input, hypothesisIds, fingerprint).
 *   2. Emit ATTEMPT_STARTED.
 *   3. Call executor.execute({ state, action, attempt, signal }).
 *   4. Apply the result:
 *        executed → materialize → apply Observation/Evidence/Artifact/Candidate → updateHypothesis → ATTEMPT_COMPLETED
 *        skipped  → ATTEMPT_SKIPPED
 *        stop     → no Attempt, record StrategyDecision, exit loop
 *        failed   → failure Observation/Evidence, ATTEMPT_FAILED
 */

import type { CTFTaskState } from '../ctfRuntime/taskState.js'
import type { CTFAttempt } from '../ctfRuntime/taskState.js'
import type { SuggestedAction } from './suggestedAction.js'
import type { ActionExecutionResult } from './actionExecutionResult.js'

export interface StrategyActionExecutorContext {
  taskState: Readonly<CTFTaskState>
  action: SuggestedAction
  attempt: CTFAttempt
  signal: AbortSignal
}

export interface StrategyActionExecutor {
  execute(ctx: StrategyActionExecutorContext): Promise<ActionExecutionResult>
}

/** A noop executor — used by tests / dry-runs. Returns
 *  `executed` with an empty materialized result. */
export const noopStrategyActionExecutor: StrategyActionExecutor = {
  async execute(_ctx): Promise<ActionExecutionResult> {
    return {
      status: 'executed',
      materializedResult: {
        observations: [],
        evidence: [],
        suggestedActions: [],
        flagCandidateDrafts: [],
        warnings: [],
        rawArtifactIds: [],
      },
      executionRefs: {},
    }
  },
}