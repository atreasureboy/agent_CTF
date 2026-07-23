/**
 * StrategyDecision — Phase 2.1 §十六.
 *
 * The StrategyPlanner emits one of these per cycle. It records the
 * chosen action (if any), the rejected alternatives with the reason
 * each was rejected, and the observation/evidence/hypothesis ids that
 * grounded the decision.
 */

import { randomBytes } from 'crypto'
import type { SuggestedAction } from './suggestedAction.js'

export type RejectedReason =
  | 'duplicate_attempt'
  | 'scope_denied'
  | 'profile_denied'
  | 'tool_unavailable'
  | 'budget_denied'
  | 'task_terminal'
  | 'missing_input'
  | 'lower_value_alternative'
  | 'hypothesis_rejected'
  | 'manual_approval_required'

export interface RejectedAction {
  action: SuggestedAction
  reason: RejectedReason
  detail?: string
}

export interface StrategyDecision {
  id: string
  taskId: string
  selectedAction?: SuggestedAction
  rejectedActions: RejectedAction[]
  reason: string
  basedOnObservationIds: string[]
  basedOnEvidenceIds: string[]
  basedOnHypothesisIds: string[]
  createdAt: number
}

export function createStrategyDecision(
  taskId: string,
  draft: Omit<StrategyDecision, 'id' | 'taskId' | 'createdAt'>,
): StrategyDecision {
  return {
    id: `sd_${randomBytes(6).toString('hex')}`,
    taskId,
    ...draft,
    createdAt: Date.now(),
  }
}