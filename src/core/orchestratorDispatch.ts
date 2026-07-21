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
    renderer?: import('../ui/renderer.js').Renderer
    userMessage?: string
    history?: import('./types.js').OpenAIMessage[]
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

  // Inherit Findings + Artifacts referenced by the handoff.
  const inheritedFindings = parent.findingStore.list()
    .filter((f) => next.findingIds.includes(f.id))
    .map((f) => ({ id: f.id, summary: f.summary, confidence: f.confidence, category: f.category, title: f.title }))
  const inheritedArtifacts = parent.artifactStore.list()
    .filter((a) => next.artifactIds.includes(a.id))
    .map((a) => ({ id: a.id, type: a.type, summary: a.summary, size: a.size }))

  parent.eventLog.append('handoff_requested', 'orchestrator-dispatch', {
    handoffId: next.id,
    fromAgent: next.fromAgent,
    suggestedAgent: next.suggestedAgent,
    inheritedFindingCount: inheritedFindings.length,
    inheritedArtifactCount: inheritedArtifacts.length,
    autoExecute: Boolean(options.autoExecute),
  }, ['orchestrator', 'handoff', 'dispatch'])

  if (!options.autoExecute) {
    return {
      handoff: { ...next, status: 'approved' },
      status: 'approved',
      reason: 'orchestrator approved',
      executedOn: {
        profile: next.suggestedAgent,
        summary: `inherit ${inheritedFindings.length} findings, ${inheritedArtifacts.length} artifacts (no autoExecute)`,
      },
    }
  }

  // Spawn the receiving harness — sub-dir under the parent's workspace.
  const child = createHarness({
    cwd: options.cwd ?? parent.taskWorkspace.paths.workspaceDir,
    profile: resolveAgentProfile(next.suggestedAgent),
    client: options.openaiClient,
    renderer: options.renderer,
    inlineMaxBytes: 1024,
  })

  // Build the system-prompt addon. This is the critical bit: the receiving
  // agent sees the inherited context as part of its system prompt and is
  // explicitly told NOT to re-analyse the original input from scratch.
  const addon = buildInheritedContextAddon(next, inheritedFindings, inheritedArtifacts)

  // Without a renderer we cannot actually run the LLM turn; return the
  // inheritance summary so the caller can dispatch with their own UI later.
  if (!options.renderer) {
    return {
      handoff: { ...next, status: 'approved' },
      status: 'approved',
      reason: 'prepared sub-harness with inherited context; pass renderer to runTurn to execute',
      executedOn: {
        profile: next.suggestedAgent,
        summary: `inherit ${inheritedFindings.length} findings, ${inheritedArtifacts.length} artifacts`,
      },
    }
  }

  const userMessage = options.userMessage ?? `Continue from handoff ${next.id} (objective: ${next.objective})`
  const history = options.history ?? []
  const result = await child.runTurn(userMessage, history, { systemPromptAddon: addon })
  return {
    handoff: { ...next, status: 'approved' },
    status: 'approved',
    reason: 'dispatched to sub-harness with inherited context',
    executedOn: {
      profile: next.suggestedAgent,
      summary: `inherited ${inheritedFindings.length} findings, ${inheritedArtifacts.length} artifacts; turn finished: ${result.stopped}`,
    },
  }
}

/**
 * Render inherited Findings + Artifacts as a system-prompt addon the child
 * agent will see. This is the message that prevents the child from re-running
 * triage on the original input.
 */
function buildInheritedContextAddon(
  handoff: HandoffRequest,
  findings: Array<{ id: string; category: string; title: string; summary: string; confidence: string }>,
  artifacts: Array<{ id: string; type: string; summary: string; size?: number }>,
): string {
  const lines: string[] = []
  lines.push('## Handoff inherited context (do NOT re-analyse the original input)')
  lines.push('')
  lines.push(`You are continuing work handed off from agent "${handoff.fromAgent}".`)
  lines.push(`Reason: ${handoff.reason}`)
  lines.push(`Objective: ${handoff.objective}`)
  if (handoff.constraints && handoff.constraints.length > 0) {
    lines.push(`Constraints: ${handoff.constraints.join('; ')}`)
  }
  lines.push('')
  if (findings.length === 0 && artifacts.length === 0) {
    lines.push('No inherited findings or artifacts — start from the objective above.')
  } else {
    if (artifacts.length > 0) {
      lines.push('### Inherited Artifacts')
      for (const a of artifacts) {
        lines.push(`- [${a.id}] ${a.type}${a.size !== undefined ? ` (${a.size}B)` : ''} — ${a.summary}`)
      }
    }
    if (findings.length > 0) {
      lines.push('### Inherited Findings')
      for (const f of findings) {
        lines.push(`- [${f.id}] (${f.category}/${f.confidence}) ${f.title} — ${f.summary}`)
      }
    }
  }
  lines.push('')
  lines.push('Operate on the inherited data above. Do NOT re-run triage on the original input.')
  return lines.join('\n')
}

function resolveAgentProfile(id: string): import('./capabilityProfile.js').CapabilityProfile {
  const builtin = getBuiltinProfile(id)
  if (builtin) return builtin
  if (PROFILES[id]) return PROFILES[id]
  throw new Error(`No builtin profile named "${id}" for handoff dispatch`)
}
