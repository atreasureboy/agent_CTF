/**
 * StrategyPlanner — Phase 2.1 §十六.
 *
 * Deterministic planner. Given the latest observations + evidence and
 * a list of candidate actions, picks the highest-priority allowed
 * action (or stop), records a StrategyDecision with the rejected
 * alternatives and the reason.
 *
 * Planner does NOT execute — it only produces the StrategyDecision.
 * Execution is the ReasoningCoordinator's job.
 */

import type { CTFTaskState } from '../ctfRuntime/taskState.js'
import type { RejectedAction, StrategyDecision } from './strategyDecision.js'
import { createStrategyDecision } from './strategyDecision.js'
import type { SuggestedAction } from './suggestedAction.js'
import { evaluateCostPolicy, type CostPolicyInput } from './costPolicy.js'
import { shouldRunTool, type ToolSelectionDecision } from './toolSelectionPolicy.js'
import { createAttemptDeduplicator } from './attemptDeduplicator.js'
import { createAttemptFingerprint } from './attemptFingerprint.js'

export interface StrategyPlanningInput {
  state: Readonly<CTFTaskState>
  newObservationIds: string[]
  newEvidenceIds: string[]
  suggestedActions: SuggestedAction[]
  cost: CostPolicyInput
}

export function planStrategy(input: StrategyPlanningInput): StrategyDecision {
  const taskTerminal = input.state.completion !== undefined
  if (taskTerminal) {
    return createStrategyDecision(input.state.taskId, {
      selectedAction: undefined,
      rejectedActions: input.suggestedActions.map((a) => ({ action: a, reason: 'task_terminal' as const })),
      reason: 'task is in a terminal phase',
      basedOnObservationIds: input.newObservationIds,
      basedOnEvidenceIds: input.newEvidenceIds,
      basedOnHypothesisIds: [],
    })
  }
  const dedup = createAttemptDeduplicator()

  // Priority tiers (highest first):
  //   1. verified flag candidate (stop after verify)
  //   2. high-confidence cheap action
  //   3. normal action
  //   4. expensive action
  const ranked = [...input.suggestedActions].sort((a, b) => b.priority - a.priority)
  const rejected: RejectedAction[] = []
  let selected: SuggestedAction | undefined

  for (const action of ranked) {
    const reasons: RejectedAction['reason'][] = []
    if (action.type === 'verify_flag') {
      const cand = input.state.flagCandidates.find((c) => c.id === action.candidateId)
      if (!cand) reasons.push('missing_input')
    }
    if (action.type === 'run_oneshot' || action.type === 'run_workflow' || action.type === 'call_tool') {
      // §round-3 audit fix — same parameters + same targetId must
      // hash to the same fingerprint regardless of how the planner
      // builds the object. We extract a single canonical descriptor
      // here and reuse it for both the dedup check and the hash.
      const kind = action.type === 'run_oneshot' ? 'oneshot' : action.type === 'run_workflow' ? 'workflow' : 'tool'
      const targetId = action.type === 'run_oneshot' ? action.manifestId : action.type === 'run_workflow' ? action.workflowId : action.toolId
      const parameters = action.type === 'run_oneshot'
        ? { options: action.options ?? {} }
        : action.type === 'run_workflow'
          ? { inputs: action.inputs }
          : { input: action.input }
      const inputArtifactIds = action.type === 'run_oneshot' ? action.inputArtifactIds : undefined
      const fingerprint = createAttemptFingerprint({ kind, targetId, parameters, inputArtifactIds })
      const decision = dedup.check(
        { kind, targetId, input: parameters, inputArtifactIds },
        input.state,
      )
      if (!decision.allowed && !decision.overrideRecorded) {
        reasons.push(decision.reason === 'already_succeeded' || decision.reason === 'already_running' || decision.reason === 'immediate_retry'
          ? 'duplicate_attempt'
          : 'duplicate_attempt')
      }
      const costDecision = evaluateCostPolicy(action, { ...input.cost, taskTerminal: false })
      if (!costDecision.allowed) {
        reasons.push(costDecision.reason === 'budget_exceeded'
          ? 'budget_denied'
          : costDecision.reason === 'heavy_not_approved'
            ? 'manual_approval_required'
            : 'budget_denied')
      }
      const toolDecision: ToolSelectionDecision = shouldRunTool(action, input.state, ranked)
      if (!toolDecision.allowed && toolDecision.reason) {
        reasons.push(toolDecision.reason === 'already_completed'
          ? 'duplicate_attempt'
          : toolDecision.reason === 'lower_value_alternative'
            ? 'lower_value_alternative'
            : 'duplicate_attempt')
      }
      // touch fingerprint so it's not unused (debug aid)
      void fingerprint
    }
    if (reasons.length === 0) {
      selected = action
      break
    }
    rejected.push({ action, reason: reasons[0]!, detail: reasons.join(',') })
  }

  return createStrategyDecision(input.state.taskId, {
    selectedAction: selected,
    rejectedActions: rejected,
    reason: selected
      ? `selected ${selected.type} with priority ${selected.priority}`
      : 'no eligible action — stopping',
    basedOnObservationIds: input.newObservationIds,
    basedOnEvidenceIds: input.newEvidenceIds,
    basedOnHypothesisIds: [],
  })
}