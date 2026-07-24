/**
 * StrategyPlanner — Phase 2.2 §十.
 *
 * Picks the highest-priority SuggestedAction (or `stop`) given the
 * current task state. Each candidate is scored by an explicit,
 * auditable formula:
 *
 *   score = priority
 *         + hypothesisPriorityWeight   (hypothesis weight, max 3)
 *         + expectedInformationGain    (number of unanswered Hyp., max 3)
 *         + evidenceFreshness          (≤3 if Evidence < 30s old)
 *         − costPenalty                (cheap=0, normal=1, expensive=3)
 *         − duplicatePenalty           (same kind+target+params already attempted)
 *         − failureHistoryPenalty      (failed attempts on this target)
 *
 * The Planner records the picked action in a `StrategyDecision` with
 * basedOnHypothesisIds / basedOnEvidenceIds / basedOnObservationIds
 * fully populated.
 *
 * Stop is a valid action — when picked, the decision has no
 * selectedAction and a reason ending in "stopping".
 */

import type { CTFTaskState, CTFHypothesis, CTFAttempt } from '../ctfRuntime/taskState.js'
import type { RejectedAction, StrategyDecision } from './strategyDecision.js'
import { createStrategyDecision } from './strategyDecision.js'
import type { SuggestedAction } from './suggestedAction.js'
import { evaluateCostPolicy, type CostPolicyInput } from './costPolicy.js'
import { shouldRunTool, type ToolSelectionDecision } from './toolSelectionPolicy.js'
import { createAttemptDeduplicator } from './attemptDeduplicator.js'
import { createAttemptFingerprint } from './attemptFingerprint.js'
import {
  evaluateReasoningBudget,
  type ReasoningBudgetState,
  type ReasoningBudgetLimits,
} from './reasoningBudget.js'

export interface StrategyPlanningInput {
  state: Readonly<CTFTaskState>
  newObservationIds: string[]
  newEvidenceIds: string[]
  suggestedActions: SuggestedAction[]
  cost: CostPolicyInput
  budget: {
    state: ReasoningBudgetState
    limits: ReasoningBudgetLimits
    heavyApproved: boolean
  }
}

export function planStrategy(input: StrategyPlanningInput): StrategyDecision {
  const taskTerminal = input.state.completion !== undefined
  if (taskTerminal) {
    return createStrategyDecision(input.state.taskId, {
      selectedAction: undefined,
      rejectedActions: input.suggestedActions.map((a) => ({
        action: a,
        reason: 'task_terminal' as const,
      })),
      reason: 'task is in a terminal phase',
      basedOnObservationIds: input.newObservationIds,
      basedOnEvidenceIds: input.newEvidenceIds,
      basedOnHypothesisIds: input.state.hypotheses
        .filter((h) => h.status !== 'rejected')
        .map((h) => h.id),
    })
  }
  const dedup = createAttemptDeduplicator()

  // Honour stop first.
  const stop = input.suggestedActions.find((a) => a.type === 'stop')
  if (stop) {
    const relatedHypotheses = input.state.hypotheses
      .filter((h) => h.status === 'supported' || h.status === 'rejected')
      .map((h) => h.id)
    return createStrategyDecision(input.state.taskId, {
      selectedAction: undefined,
      rejectedActions: input.suggestedActions
        .filter((a) => a.type !== 'stop')
        .map((a) => ({ action: a, reason: 'task_terminal' as const })),
      reason: 'planner emitted stop',
      basedOnObservationIds: input.newObservationIds,
      basedOnEvidenceIds: input.newEvidenceIds,
      basedOnHypothesisIds: relatedHypotheses,
    })
  }

  const ranked = [...input.suggestedActions].sort((a, b) => b.priority - a.priority)
  const rejected: RejectedAction[] = []
  let selected: SuggestedAction | undefined
  let selectedScore = Number.NEGATIVE_INFINITY
  let selectedBasedOn: { h: string[]; e: string[]; o: string[] } | undefined

  for (const action of ranked) {
    const reasons: RejectedAction['reason'][] = []
    let basedOn: { h: string[]; e: string[]; o: string[] } = {
      h: [],
      e: [],
      o: input.newObservationIds,
    }

    // Hard rules first.
    if (action.type === 'verify_flag') {
      const cand = input.state.flagCandidates.find((c) => c.id === action.candidateId)
      if (!cand) reasons.push('missing_input')
    }

    if (
      action.type === 'run_oneshot' ||
      action.type === 'run_workflow' ||
      action.type === 'call_tool'
    ) {
      const kind =
        action.type === 'run_oneshot'
          ? 'oneshot'
          : action.type === 'run_workflow'
            ? 'workflow'
            : 'tool'
      const targetId =
        action.type === 'run_oneshot'
          ? action.manifestId
          : action.type === 'run_workflow'
            ? action.workflowId
            : action.toolId
      const parameters =
        action.type === 'run_oneshot'
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
        reasons.push('duplicate_attempt')
      }
      const costDecision = evaluateCostPolicy(action, { ...input.cost, taskTerminal: false })
      if (!costDecision.allowed) {
        reasons.push(costDecision.reason === 'budget_exceeded' ? 'budget_denied' : 'budget_denied')
      }
      const budgetDecision = evaluateReasoningBudget(
        action,
        input.budget.state,
        input.budget.limits,
        { heavyApproved: input.budget.heavyApproved, taskTerminal: false },
      )
      if (!budgetDecision.allowed) {
        reasons.push('budget_denied')
      }
      const toolDecision: ToolSelectionDecision = shouldRunTool(action, input.state, ranked)
      if (!toolDecision.allowed && toolDecision.reason) {
        reasons.push(
          toolDecision.reason === 'already_completed'
            ? 'duplicate_attempt'
            : 'lower_value_alternative',
        )
      }
      // Reject if the action targets a rejected hypothesis.
      if (action.hypothesisIds && action.hypothesisIds.length > 0) {
        const allRejected = action.hypothesisIds.every(
          (id) => input.state.hypotheses.find((h) => h.id === id)?.status === 'rejected',
        )
        if (allRejected) reasons.push('hypothesis_rejected')
      }
      void fingerprint
    }

    if (reasons.length === 0) {
      // Compute the score (positive contribution from hypothesis +
      // freshness, penalties for cost / duplicate / failures).
      const score = scoreAction(action, input.state, input.newObservationIds)
      const based = basedOnFor(action, input.state, input.newEvidenceIds, input.newObservationIds)
      basedOn = based
      if (score > selectedScore) {
        selected = action
        selectedScore = score
        selectedBasedOn = based
      }
    } else {
      rejected.push({ action, reason: reasons[0], detail: reasons.join(',') })
    }
  }

  return createStrategyDecision(input.state.taskId, {
    selectedAction: selected,
    rejectedActions: rejected,
    reason: selected
      ? `selected ${selected.type} priority=${selected.priority} score=${selectedScore.toFixed(2)}`
      : 'no eligible action — stopping',
    basedOnObservationIds: selectedBasedOn?.o ?? input.newObservationIds,
    basedOnEvidenceIds: selectedBasedOn?.e ?? input.newEvidenceIds,
    basedOnHypothesisIds: selectedBasedOn?.h ?? [],
  })
}

function scoreAction(
  action: SuggestedAction,
  state: Readonly<CTFTaskState>,
  newObservationIds: string[],
): number {
  // base priority
  let score = action.priority

  // hypothesis weight
  const linked = (action.hypothesisIds ?? [])
    .map((id) => state.hypotheses.find((h) => h.id === id))
    .filter(Boolean) as CTFHypothesis[]
  const unresolved = linked.filter(
    (h) => h.status !== 'rejected' && h.status !== 'supported',
  ).length
  score += Math.min(3, unresolved)

  // information gain — count how many open hypotheses the action
  // would advance (heuristic: by category match)
  const cats = new Set(linked.map((h) => h.category))
  if (cats.size > 0) score += 1

  // evidence freshness — recent observations contribute
  if (newObservationIds.length > 0) score += Math.min(3, newObservationIds.length * 0.5)

  // cost penalty
  score -= action.costTier === 'expensive' ? 3 : action.costTier === 'normal' ? 1 : 0

  // duplicate / failure penalties
  score -= duplicatePenalty(action, state)
  score -= failurePenalty(action, state)

  return score
}

function duplicatePenalty(action: SuggestedAction, state: Readonly<CTFTaskState>): number {
  if (
    action.type === 'run_workflow' ||
    action.type === 'run_oneshot' ||
    action.type === 'call_tool'
  ) {
    const kind =
      action.type === 'run_oneshot'
        ? 'oneshot'
        : action.type === 'run_workflow'
          ? 'workflow'
          : 'tool'
    const targetId =
      action.type === 'run_oneshot'
        ? action.manifestId
        : action.type === 'run_workflow'
          ? action.workflowId
          : action.toolId
    const existing = state.attempts.filter((a) => a.kind === kind && a.targetId === targetId)
    return existing.length
  }
  return 0
}

function failurePenalty(action: SuggestedAction, state: Readonly<CTFTaskState>): number {
  if (
    action.type === 'run_workflow' ||
    action.type === 'run_oneshot' ||
    action.type === 'call_tool'
  ) {
    const kind =
      action.type === 'run_oneshot'
        ? 'oneshot'
        : action.type === 'run_workflow'
          ? 'workflow'
          : 'tool'
    const targetId =
      action.type === 'run_oneshot'
        ? action.manifestId
        : action.type === 'run_workflow'
          ? action.workflowId
          : action.toolId
    const failures = state.attempts.filter(
      (a): a is CTFAttempt => a.kind === kind && a.targetId === targetId && a.status === 'failed',
    )
    return failures.length
  }
  return 0
}

function basedOnFor(
  action: SuggestedAction,
  state: Readonly<CTFTaskState>,
  newEvidenceIds: string[],
  newObservationIds: string[],
): { h: string[]; e: string[]; o: string[] } {
  const linkedHypothesisIds = (action.hypothesisIds ?? []).filter((id) =>
    state.hypotheses.some((h) => h.id === id),
  )
  const evidenceIds = new Set<string>(newEvidenceIds)
  for (const id of linkedHypothesisIds) {
    const h = state.hypotheses.find((x) => x.id === id)
    if (!h) continue
    for (const ev of h.supportingEvidenceIds) evidenceIds.add(ev)
    for (const ev of h.contradictingEvidenceIds) evidenceIds.add(ev)
  }
  return { h: linkedHypothesisIds, e: [...evidenceIds], o: newObservationIds }
}
