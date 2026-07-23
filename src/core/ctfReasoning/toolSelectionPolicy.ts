/**
 * ToolSelectionPolicy — Phase 2.1 §十七.
 *
 * Decides whether a tool/workflow/oneShot is currently worth running
 * given:
 *   - the existing evidence (sufficient?)
 *   - the available alternatives
 *   - whether the same triage has already been completed
 *
 * Pure function over the state. Does not execute.
 */

import type { CTFTaskState } from '../ctfRuntime/taskState.js'
import type { SuggestedAction } from './suggestedAction.js'

export interface ToolSelectionDecision {
  allowed: boolean
  reason?: 'insufficient_evidence' | 'already_completed' | 'triage_exists' | 'lower_value_alternative'
  alternativeId?: string
}

/** Decide whether a tool call is worth running. The Planner supplies
 *  `alternatives` so we can prefer a higher-value one. */
export function shouldRunTool(
  action: SuggestedAction,
  state: Readonly<CTFTaskState>,
  alternatives: SuggestedAction[] = [],
): ToolSelectionDecision {
  // If a satisfied attempt exists for the same target, refuse.
  const targetId = action.type === 'run_oneshot' ? action.manifestId
    : action.type === 'run_workflow' ? action.workflowId
    : action.type === 'call_tool' ? action.toolId
    : null
  if (targetId) {
    const completed = state.attempts.find(
      (a) => a.targetId === targetId && a.status === 'succeeded',
    )
    if (completed) {
      return { allowed: false, reason: 'already_completed' }
    }
  }

  // If we have a higher-priority alternative in the same tier, prefer it.
  const higher = alternatives.find((a) => a.priority > action.priority)
  if (higher) {
    return { allowed: false, reason: 'lower_value_alternative', alternativeId: idOf(higher) }
  }
  return { allowed: true }
}

function idOf(a: SuggestedAction): string {
  switch (a.type) {
    case 'run_workflow': return a.workflowId
    case 'run_oneshot': return a.manifestId
    case 'call_tool': return a.toolId
    case 'request_handoff': return a.capability
    case 'verify_flag': return a.candidateId
    case 'stop': return 'stop'
  }
}