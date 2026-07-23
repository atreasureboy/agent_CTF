/**
 * CostPolicy — Phase 2.1 §十七.
 *
 * Pure function. Decides whether an action can run given the current
 * budget + cost tier. The Planner consults this before any
 * `selectedAction` lands in a StrategyDecision.
 */

import type { BudgetLimits } from '../../ctf/oneshot/types.js'
import type { CostTier, SuggestedAction } from './suggestedAction.js'
import type { CTFTaskState } from '../ctfRuntime/taskState.js'

export interface CostPolicyInput {
  limits: BudgetLimits
  currentSpend: { fast: number; medium: number; heavy: number }
  heavyApproved: boolean
  taskTerminal: boolean
}

export interface CostPolicyDecision {
  allowed: boolean
  reason?: 'task_terminal' | 'budget_exceeded' | 'heavy_not_approved'
}

export function evaluateCostPolicy(
  action: SuggestedAction,
  input: CostPolicyInput,
): CostPolicyDecision {
  if (input.taskTerminal) {
    return { allowed: false, reason: 'task_terminal' }
  }
  if (action.costTier === 'expensive' && !input.heavyApproved) {
    return { allowed: false, reason: 'heavy_not_approved' }
  }
  const tier = action.costTier === 'expensive' ? 'heavy' : action.costTier === 'normal' ? 'medium' : 'fast'
  const cap = input.limits[tier === 'heavy' ? 'heavyConcurrency' : tier === 'medium' ? 'mediumConcurrency' : 'fastConcurrency']
  if (input.currentSpend[tier] >= cap) {
    return { allowed: false, reason: 'budget_exceeded' }
  }
  return { allowed: true }
}