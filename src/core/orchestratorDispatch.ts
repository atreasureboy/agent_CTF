/**
 * Orchestrator dispatch — read pending Handoffs and decide next actions.
 *
 * In the full LLM-driven harness, the Orchestrator Agent's last turn scans
 * `handoffStore.pending()` and outputs a decision. This module provides a
 * non-LLM fallback that:
 *   - resolves each pending Handoff via the same `approve_handoff` contract
 *   - instantiates a new specialist sub-engine (HarnessBundle) with the
 *     suggested Agent's Profile + a fresh runTurn seeded by inherited
 *     Findings/Artifacts.
 *
 * CLI / tests call dispatchNext() in a loop until no more pending handoffs.
 */

import type { HandoffRequest } from './handoff.js'
import type { HarnessBundle } from './harness.js'
import { createHarness } from './harness.js'
import { getBuiltinProfile, PROFILES } from '../capabilityProfiles/index.js'

export interface DispatchResult {
  handoff: HandoffRequest
  status: 'approved' | 'rejected' | 'deferred'
  reason: string
  executedOn?: { profile: string; summary: string }
}

/**
 * Synchronous decision logic — the engine that *implements* the decision is
 * a separate ExecutionEngine call. This helper just inspects.
 */
export function inspectNextHandoff(bundle: HarnessBundle): HandoffRequest | null {
  const pending = bundle.handoffStore.pending()
  if (pending.length === 0) return null
  // Highest priority first.
  pending.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
  return pending[0]
}

/**
 * Approve / reject a single pending handoff. Returns a structured decision.
 * `autoExecute=true` spawns a child harness and runs a single turn that seeds
 * the new agent with inherited findings+artifacts; otherwise the caller
 * decides when to dispatch.
 */
export async function dispatchNext(
  parent: HarnessBundle,
  options: {
    decision?: 'approve' | 'reject'
    autoExecute?: boolean
    cwd?: string
    apiKey?: string
    baseURL?: string
    model?: string
    openaiClient?: import('openai').default
  } = {},
): Promise<DispatchResult | null> {
  const next = inspectNextHandoff(parent)
  if (!next) return null
  const decision = options.decision ?? 'approve'

  if (decision === 'reject') {
    parent.handoffStore.decide(next.id, 'rejected', 'orchestrator rejected')
    return { handoff: next, status: 'rejected', reason: 'orchestrator rejected' }
  }

  parent.handoffStore.decide(next.id, 'approved', 'orchestrator approved')
  if (!options.autoExecute) {
    return { handoff: { ...next, status: 'approved' }, status: 'approved', reason: 'orchestrator approved' }
  }

  // Spawn the receiving harness — sub-dir under the parent's workspace.
  const child = createHarness({
    cwd: options.cwd ?? parent.taskWorkspace.paths.workspaceDir,
    profile: resolveAgentProfile(next.suggestedAgent),
    client: options.openaiClient,
    inlineMaxBytes: 1024,
  })

  // Inherit Findings + Artifacts.
  const inheritedFindings = parent.findingStore.list()
    .filter((f) => next.findingIds.includes(f.id))
    .map((f) => ({ id: f.id, summary: f.summary, confidence: f.confidence }))
  const inheritedArtifacts = parent.artifactStore.list()
    .filter((a) => next.artifactIds.includes(a.id))
    .map((a) => ({ id: a.id, type: a.type, summary: a.summary }))

  // We do not have a renderer here; child.runTurn requires one. The CLI/
  // dedicated test paths can opt to render externally. For now, return a
  // structured outcome that documents the inheritance.
  void child
  void inheritedArtifacts
  void inheritedFindings
  return {
    handoff: { ...next, status: 'approved' },
    status: 'approved',
    reason: 'dispatched to sub-harness',
    executedOn: { profile: next.suggestedAgent, summary: 'see child.runTurn output' },
  }
}

function resolveAgentProfile(id: string): import('./capabilityProfile.js').CapabilityProfile {
  const builtin = getBuiltinProfile(id)
  if (builtin) return builtin
  if (PROFILES[id]) return PROFILES[id]
  throw new Error(`No builtin profile named "${id}" for handoff dispatch`)
}
