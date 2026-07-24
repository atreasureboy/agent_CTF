/**
 * Orchestrator dispatch — minimum legacy shim.
 *
 * Per forth_goal.md §六 the file is reduced to:
 *   - `dispatchNext(parent, { orchestrator?, decision? })` returning a
 *     DispatchResult.
 *   - Throws when no orchestrator is attached.
 *   - Approve / reject delegates to `CTFTaskOrchestrator`.
 *   - No fallback to a child harness, no autoExecute, no env-derived
 *     client/renderer/model imports.
 *
 * The ONLY allowed Specialist spawn site is:
 *   CTFTaskOrchestrator → HandoffCoordinator → SpecialistHarnessFactory
 */

import type { HandoffRequest } from './handoff.js'
import type { HarnessBundle } from './harness.js'
import type { CTFTaskOrchestrator } from './ctfRuntime/taskOrchestrator.js'

export interface DispatchResult {
  handoff: HandoffRequest
  status: 'approved' | 'rejected'
  reason: string
  executedOn?: { profile: string; summary: string }
}

/**
 * Synchronous decision logic — pick the highest-priority pending handoff.
 */
export function inspectNextHandoff(bundle: HarnessBundle): HandoffRequest | null {
  const pending = bundle.handoffStore.pending()
  if (pending.length === 0) return null
  pending.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
  return pending[0]
}

/**
 * Approve or reject the next pending handoff on `parent`.
 *
 * Routing:
 *   - approve + orchestrator  →  orchestrator.approveHandoff(next.id)
 *   - reject  + orchestrator  →  orchestrator.rejectHandoff(next.id, ...)
 *   - anything without orchestrator → throws (legacy fallback gone)
 */
export async function dispatchNext(
  parent: HarnessBundle,
  options: {
    orchestrator?: CTFTaskOrchestrator
    decision?: 'approve' | 'reject'
  },
): Promise<DispatchResult | null> {
  if (!options.orchestrator) {
    throw new Error(
      'dispatchNext requires an attached CTFTaskOrchestrator — no orchestrator was supplied. ' +
        'The standalone dispatch path was removed in the forth_goal refactor.',
    )
  }
  const orchestrator = options.orchestrator
  const next = inspectNextHandoff(parent)
  if (!next) return null
  const decision = options.decision ?? 'approve'

  if (decision === 'reject') {
    orchestrator.rejectHandoff(next.id, 'orchestrator rejected')
    return {
      handoff: { ...next, status: 'rejected' },
      status: 'rejected',
      reason: 'orchestrator rejected',
    }
  }

  // Translate the legacy HandoffRequest into an orchestrator-side Record.
  // The orchestrator owns the lifecycle; the legacy store entry is a
  // handoff envelope that we mirror into TaskState.
  const fromAgentRunId =
    orchestrator.getState().agentRuns.find((r) => r.profileId === next.fromAgent)?.id ??
    `legacy_${next.fromAgent}`
  const record = orchestrator.requestHandoff({
    fromAgentRunId,
    targetCapability: next.suggestedAgent,
    targetAgentId: next.suggestedAgent,
    reason: next.reason,
    objective: next.objective,
    artifactIds: next.artifactIds,
    findingIds: next.findingIds,
    constraints: next.constraints,
    priority: next.priority,
  })
  const result = await orchestrator.approveHandoff(record.id)
  parent.eventLog.append(
    'handoff_requested',
    'orchestrator-dispatch',
    {
      handoffId: record.id,
      fromAgent: next.fromAgent,
      suggestedAgent: next.suggestedAgent,
      inheritedFindingCount: next.findingIds.length,
      inheritedArtifactCount: next.artifactIds.length,
    },
    ['orchestrator', 'handoff', 'dispatch'],
  )
  return {
    handoff: { ...next, status: 'approved' },
    status: 'approved',
    reason: 'orchestrator approved and dispatched',
    executedOn: {
      profile: next.suggestedAgent,
      summary:
        result?.summary ??
        `inherited ${next.findingIds.length} findings, ${next.artifactIds.length} artifacts`,
    },
  }
}
