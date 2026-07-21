/**
 * Orchestrator dispatch — legacy entry point that delegates to
 * `CTFTaskOrchestrator.approveHandoff` when an orchestrator is supplied.
 *
 * The previous version of this file created a child `HarnessBundle` ad-hoc
 * to run the specialist turn. That created two parallel execution paths
 * (here AND in the orchestrator). After the refactor there is ONE flow:
 *
 *   `dispatchNext(parent, { orchestrator })` → orchestrator.approveHandoff
 *
 * When called without an orchestrator, this function still works for
 * backwards compatibility but performs a simpler "mark approved + return
 * summary" operation (no specialist run). Tests / CLI that previously relied
 * on the autoExecute path should migrate to the orchestrator.
 */

import type { HandoffRequest } from './handoff.js'
import type { HarnessBundle } from './harness.js'
import { createHarness } from './harness.js'
import { getBuiltinProfile, PROFILES } from '../capabilityProfiles/index.js'
import type { CTFTaskOrchestrator } from './ctfRuntime/taskOrchestrator.js'

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
 * Approve / reject a single pending handoff.
 *
 * When `options.orchestrator` is provided, this is a thin delegate — the
 * orchestrator's single approval path runs the Specialist. Otherwise this is
 * the legacy compatibility shim: it marks the handoff as approved without
 * starting a specialist, and (when `autoExecute` and a renderer are both
 * present) creates a one-shot sub-harness to execute the inherited turn.
 *
 * New code MUST supply an orchestrator; the standalone path is preserved
 * only for tests that do not exercise the full lifecycle.
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
    /** When supplied, all Handoff execution routes through this orchestrator. */
    orchestrator?: CTFTaskOrchestrator
  } = {},
): Promise<DispatchResult | null> {
  const next = inspectNextHandoff(parent)
  if (!next) return null
  const decision = options.decision ?? 'approve'

  // ── Preferred path: orchestrator owns the lifecycle. ────────────────
  if (options.orchestrator) {
    if (decision === 'reject') {
      options.orchestrator.rejectHandoff(next.id, 'orchestrator rejected')
      const after = options.orchestrator.getState().handoffs.find((h) => h.id === next.id)!
      return {
        handoff: { ...next, status: 'rejected' },
        status: 'rejected',
        reason: 'orchestrator rejected',
      }
    }
    const fromAgentRunId =
      options.orchestrator.getState().activeAgentRuns.find(
        (r) => r.profileId === next.fromAgent,
      )?.id ?? `legacy_${next.fromAgent}`
    // Translate the legacy HandoffRequest (status=pending) into the
    // orchestrator's Record-shaped flow.
    const record = options.orchestrator.requestHandoff({
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
    const result = await options.orchestrator.approveHandoff(record.id)
    parent.eventLog.append('handoff_requested', 'orchestrator-dispatch', {
      handoffId: record.id,
      fromAgent: next.fromAgent,
      suggestedAgent: next.suggestedAgent,
      inheritedFindingCount: next.findingIds.length,
      inheritedArtifactCount: next.artifactIds.length,
      autoExecute: Boolean(options.autoExecute),
    }, ['orchestrator', 'handoff', 'dispatch'])
    return {
      handoff: { ...next, status: 'approved' },
      status: 'approved',
      reason: 'orchestrator approved and dispatched',
      executedOn: {
        profile: next.suggestedAgent,
        summary: result?.summary ?? `inherited ${next.findingIds.length} findings, ${next.artifactIds.length} artifacts`,
      },
    }
  }

  // ── Legacy shim path (no orchestrator) ───────────────────────────────
  if (decision === 'reject') {
    parent.handoffStore.decide(next.id, 'rejected', 'orchestrator rejected')
    return { handoff: next, status: 'rejected', reason: 'orchestrator rejected' }
  }

  if (next.status !== 'pending') {
    throw new Error(`Handoff ${next.id} already ${next.status}; dispatchNext will not re-approve.`)
  }
  parent.handoffStore.decide(next.id, 'approved', 'orchestrator approved (legacy shim)')

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
      reason: 'orchestrator approved (no autoExecute)',
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

  const addon = buildInheritedContextAddon(next, inheritedFindings, inheritedArtifacts)

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
    reason: 'dispatched to sub-harness with inherited context (legacy shim)',
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
