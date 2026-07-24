/**
 * ReasoningBudget — Phase 2.2 §十一.
 *
 * Cumulative per-task budget, persisted into TaskState. Tracks:
 *   - strategyCyclesUsed
 *   - actionsExecuted
 *   - cheapActionsUsed / normalActionsUsed / expensiveActionsUsed
 *   - workflowRunsUsed / oneShotRunsUsed / handoffsUsed
 *   - estimatedCostUnitsUsed
 *
 * Cost unit model (§十一):
 *   cheap     = 1
 *   normal    = 3
 *   expensive = 8
 *
 * Cumulative cost is NEVER refunded, even on cancellation or
 * failure. Concurrency is a separate dimension handled by the
 * existing in-flight counter (Phase 2.1).
 */

import type { CostTier } from './suggestedAction.js'
import type { SuggestedAction } from './suggestedAction.js'

export const COST_UNIT: Record<CostTier, number> = {
  cheap: 1,
  normal: 3,
  expensive: 8,
}

export interface ReasoningBudgetState {
  strategyCyclesUsed: number
  actionsExecuted: number
  cheapActionsUsed: number
  normalActionsUsed: number
  expensiveActionsUsed: number
  workflowRunsUsed: number
  oneShotRunsUsed: number
  handoffsUsed: number
  estimatedCostUnitsUsed: number
}

export interface ReasoningBudgetLimits {
  maxStrategyCycles: number
  maxActions: number
  maxCheapActions: number
  maxNormalActions: number
  maxExpensiveActions: number
  maxWorkflowRuns: number
  maxOneShotRuns: number
  maxHandoffs: number
  maxEstimatedCostUnits: number
}

export const DEFAULT_REASONING_BUDGET_LIMITS: ReasoningBudgetLimits = {
  maxStrategyCycles: 8,
  maxActions: 32,
  maxCheapActions: 24,
  maxNormalActions: 12,
  maxExpensiveActions: 4,
  maxWorkflowRuns: 8,
  maxOneShotRuns: 8,
  maxHandoffs: 4,
  maxEstimatedCostUnits: 64,
}

export function createInitialReasoningBudgetState(): ReasoningBudgetState {
  return {
    strategyCyclesUsed: 0,
    actionsExecuted: 0,
    cheapActionsUsed: 0,
    normalActionsUsed: 0,
    expensiveActionsUsed: 0,
    workflowRunsUsed: 0,
    oneShotRunsUsed: 0,
    handoffsUsed: 0,
    estimatedCostUnitsUsed: 0,
  }
}

export type BudgetDenialReason =
  | 'task_terminal'
  | 'heavy_not_approved'
  | 'budget_exceeded'
  | 'workflow_runs_exceeded'
  | 'one_shot_runs_exceeded'
  | 'handoffs_exceeded'
  | 'strategy_cycles_exceeded'
  | 'actions_exceeded'
  | 'cheap_actions_exceeded'
  | 'normal_actions_exceeded'
  | 'expensive_actions_exceeded'

export interface ReasoningBudgetDecision {
  allowed: boolean
  reason?: BudgetDenialReason
  detail?: string
}

export function evaluateReasoningBudget(
  action: SuggestedAction,
  state: ReasoningBudgetState,
  limits: ReasoningBudgetLimits,
  opts: { heavyApproved: boolean; taskTerminal: boolean },
): ReasoningBudgetDecision {
  if (opts.taskTerminal) return { allowed: false, reason: 'task_terminal' }
  if (action.costTier === 'expensive' && !opts.heavyApproved) {
    return { allowed: false, reason: 'heavy_not_approved' }
  }
  // §十九 — projection check: project the consumption BEFORE the
  // action runs. `used + 1 > max` (NOT `used >= max`) so the first
  // action over the cap is rejected and the Attempt isn't created.
  if (state.strategyCyclesUsed + 1 > limits.maxStrategyCycles) {
    return { allowed: false, reason: 'strategy_cycles_exceeded', detail: `cycles=${state.strategyCyclesUsed}/${limits.maxStrategyCycles}` }
  }
  if (state.actionsExecuted + 1 > limits.maxActions) {
    return { allowed: false, reason: 'actions_exceeded', detail: `actions=${state.actionsExecuted}/${limits.maxActions}` }
  }
  if ((state.cheapActionsUsed + (action.costTier === 'cheap' ? 1 : 0)) > limits.maxCheapActions) {
    return { allowed: false, reason: 'cheap_actions_exceeded' }
  }
  if ((state.normalActionsUsed + (action.costTier === 'normal' ? 1 : 0)) > limits.maxNormalActions) {
    return { allowed: false, reason: 'normal_actions_exceeded' }
  }
  if ((state.expensiveActionsUsed + (action.costTier === 'expensive' ? 1 : 0)) > limits.maxExpensiveActions) {
    return { allowed: false, reason: 'expensive_actions_exceeded' }
  }
  if ((state.workflowRunsUsed + (action.type === 'run_workflow' ? 1 : 0)) > limits.maxWorkflowRuns) {
    return { allowed: false, reason: 'workflow_runs_exceeded' }
  }
  if ((state.oneShotRunsUsed + (action.type === 'run_oneshot' ? 1 : 0)) > limits.maxOneShotRuns) {
    return { allowed: false, reason: 'one_shot_runs_exceeded' }
  }
  if ((state.handoffsUsed + (action.type === 'request_handoff' ? 1 : 0)) > limits.maxHandoffs) {
    return { allowed: false, reason: 'handoffs_exceeded' }
  }
  if ((state.estimatedCostUnitsUsed + COST_UNIT[action.costTier]) > limits.maxEstimatedCostUnits) {
    return { allowed: false, reason: 'budget_exceeded', detail: `cost=${state.estimatedCostUnitsUsed}/${limits.maxEstimatedCostUnits}` }
  }
  return { allowed: true }
}

export function applyReasoningBudgetConsumption(
  state: ReasoningBudgetState,
  action: SuggestedAction,
): ReasoningBudgetState {
  return {
    ...state,
    actionsExecuted: state.actionsExecuted + 1,
    cheapActionsUsed: state.cheapActionsUsed + (action.costTier === 'cheap' ? 1 : 0),
    normalActionsUsed: state.normalActionsUsed + (action.costTier === 'normal' ? 1 : 0),
    expensiveActionsUsed: state.expensiveActionsUsed + (action.costTier === 'expensive' ? 1 : 0),
    workflowRunsUsed: state.workflowRunsUsed + (action.type === 'run_workflow' ? 1 : 0),
    oneShotRunsUsed: state.oneShotRunsUsed + (action.type === 'run_oneshot' ? 1 : 0),
    handoffsUsed: state.handoffsUsed + (action.type === 'request_handoff' ? 1 : 0),
    estimatedCostUnitsUsed: state.estimatedCostUnitsUsed + COST_UNIT[action.costTier],
  }
}

export function consumeCycle(state: ReasoningBudgetState): ReasoningBudgetState {
  return { ...state, strategyCyclesUsed: state.strategyCyclesUsed + 1 }
}