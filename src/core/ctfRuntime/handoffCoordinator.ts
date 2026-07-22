/**
 * HandoffCoordinator — owns the Handoff lifecycle.
 *
 * Responsibilities (§八):
 *   - Single approval path: requested → approved → running → completed.
 *   - Reject duplicate approve (in-flight map guards against two callers).
 *   - Resolve capability → agent id using the canonical 5-level algorithm.
 *   - Build + run the Specialist harness via SpecialistHarnessFactory.
 *   - Collect findings/artifacts and project them back into TaskState.
 *
 * It does NOT own phase / profile / abort — those are CTFTaskOrchestrator's
 * concern. The coordinator is the single spawn-site for Specialist Harnesses.
 */

import { randomBytes } from 'crypto'
import { join } from 'path'

import type { CapabilityProfile } from '../capabilityProfile.js'
import type { ContestScope } from '../contestScope.js'

import type { CTFTaskStateStore } from './taskStateStore.js'
import type {
  AgentRunRecord,
  AgentRunResult,
  HandoffRecord,
  HandoffRecordStatus,
} from './taskState.js'
import { checkRegistryAvailability } from '../toolBroker.js'
import { getBuiltinProfile, PROFILES } from '../../capabilityProfiles/index.js'
import type { AgentRuntimeDependencies } from './agentRuntimeDependencies.js'
import {
  SpecialistHarnessFactory,
  type SpecialistHarnessHandle,
} from './specialistHarnessFactory.js'
import type { TaskStateProjector } from './taskStateProjector.js'
import type { LinkedAbortController } from './linkedAbortController.js'
import type { TaskExecutionContext } from './taskExecutionContext.js'
import type { ToolRegistry } from '../toolRegistry.js'
import type { TurnResult, OpenAIMessage } from '../types.js'
import type { ArtifactStore } from '../artifacts.js'
import type { FindingStore } from '../findings.js'

export interface RequestHandoffInput {
  fromAgentRunId: string
  targetCapability: string
  targetAgentId?: string
  reason: string
  objective: string
  artifactIds?: string[]
  findingIds?: string[]
  constraints?: string[]
  priority?: number
}

/**
 * §十一.2 — raised when approveAndRun is called on a handoff that is
 * already terminal (completed / failed / cancelled / rejected).
 */
export class HandoffAlreadyTerminalError extends Error {
  constructor(
    readonly handoffId: string,
    readonly terminalStatus: string,
    message: string,
  ) {
    super(message)
    this.name = 'HandoffAlreadyTerminalError'
  }
}

export interface HandoffCoordinatorDeps {
  store: CTFTaskStateStore
  /** Parent context — used to derive the specialist's narrower context. */
  parentContext: TaskExecutionContext
  parentDependencies: AgentRuntimeDependencies
  parentToolRegistry: ToolRegistry
  /** Parent artifact store — shared with the specialist so its writes are
   *  visible to the projector. */
  parentArtifactStore: ArtifactStore
  /** Parent finding store — shared with the specialist. */
  parentFindingStore: FindingStore
  /** Workspace root for child harness creation. */
  cwd: string
  sessionsRoot?: string
  parentTaskId: string
  /** Linked abort: specialist aborts when parent aborts. */
  abort: LinkedAbortController
  /** Projector for finding/artifact diff into TaskState. */
  projector: TaskStateProjector
  /** Re-emit wrapped errors. */
  wrapError(userSummary: string, cause: unknown): Error
  /** Phase 1.7 — runtime-owned Renderer used when the per-handle deps
   *  Renderer was deliberately nulled (legacy CTFTaskOrchestrator.create). */
  runtimeRenderer?: import('../../ui/renderer.js').Renderer
}

export class HandoffCoordinator {
  private readonly inFlight = new Map<string, Promise<AgentRunResult>>()
  private readonly specialized = new Map<string, SpecialistHarnessHandle>()
  private readonly specialistFactory: SpecialistHarnessFactory

  constructor(private readonly deps: HandoffCoordinatorDeps) {
    this.specialistFactory = new SpecialistHarnessFactory()
  }

  /** Apply HANDOFF_REQUESTED to the store and return the new record. */
  request(input: RequestHandoffInput): HandoffRecord {
    const record: HandoffRecord = {
      id: `hof_${randomBytes(8).toString('hex')}`,
      taskId: this.deps.store.getState().taskId,
      fromAgentRunId: input.fromAgentRunId,
      requestedCapability: input.targetCapability,
      requestedAgentId: input.targetAgentId,
      reason: input.reason,
      objective: input.objective,
      artifactIds: input.artifactIds ?? [],
      findingIds: input.findingIds ?? [],
      constraints: input.constraints,
      priority: input.priority,
      status: 'requested',
      createdAt: Date.now(),
    }
    this.deps.store.apply({ type: 'HANDOFF_REQUESTED', handoff: record })
    return record
  }

  reject(handoffId: string, reason: string): void {
    this.deps.store.apply({ type: 'HANDOFF_REJECTED', handoffId, reason })
  }

  cancel(handoffId: string, reason: string): void {
    // Phase 1.7 §十一 — cancelHandoff must actually abort the Specialist.
    // For requested/approved we just emit HANDOFF_CANCELLED; for running
    // we trigger the per-Specialist AbortController so the harness
    // observes the abort signal in its next check.
    const handle = this.specialized.get(handoffId)
    if (handle) {
      handle.abort.controller.abort(reason)
    }
    try {
      this.deps.store.apply({ type: 'HANDOFF_CANCELLED', handoffId, reason })
    } catch {
      /* already terminal — the abort signal above is still delivered */
    }
  }

  /**
   * Cancel every non-terminal handoff (requested/approved/running) and wait
   * for the running specialist promises to settle. The abort signal is
   * already wired through `deps.abort` into each specialist's context, so
   * the specialist will throw or short-circuit once the parent's controller
   * fires — the wrapper in runSpecialist catches and emits
   * SPECIALIST_CANCELLED. We don't send the event ourselves; the handoff FSM
   * reducer moves running→cancelled via SPECIALIST_CANCELLED only.
   *
   * For requested/approved handoffs (no specialist running yet) we emit
   * HANDOFF_CANCELLED directly.
   */
  async cancelAll(reason: string): Promise<void> {
    for (const h of this.deps.store.getState().handoffs) {
      if (h.status === 'requested' || h.status === 'approved') {
        try {
          this.deps.store.apply({
            type: 'HANDOFF_CANCELLED',
            handoffId: h.id,
            reason,
          })
        } catch {
          /* terminal — skip */
        }
      }
    }
    // running handoffs: abort signal already in flight, just wait for them.
    await Promise.allSettled([...this.inFlight.values()])
  }

  /**
   * Approve and run. Returns the AgentRunResult of the specialist.
   * Idempotent: re-approving a terminal handoff returns a synthetic stub;
   * re-approving while a specialist is running awaits the in-flight run.
   */
  async approveAndRun(handoffId: string): Promise<AgentRunResult | null> {
    // In-flight guard FIRST — protects concurrent callers racing on the
    // 'requested' → 'approved' transition. Without this check the second
    // call sees status='approved' and throws.
    if (this.inFlight.has(handoffId)) {
      return this.inFlight.get(handoffId)!
    }
    const h = this.deps.store.getState().handoffs.find((x) => x.id === handoffId)
    if (!h) throw new Error(`Handoff ${handoffId} not found`)
    if (this.isTerminal(h.status)) {
      // §十一.2 — terminal handoff re-approve throws a typed error
      // instead of returning a synthetic empty-result stub.
      throw new HandoffAlreadyTerminalError(
        handoffId,
        h.status,
        `Handoff ${handoffId} already in terminal state '${h.status}'; re-approval refused.`,
      )
    }
    if (h.status !== 'requested') {
      throw new Error(`Handoff ${handoffId} is not in 'requested' state (got ${h.status})`)
    }

    const selection = this.selectAgentForCapability(
      h.requestedCapability,
      h.fromAgentRunId,
      h.requestedAgentId,
    )
    if (!selection.agentId) {
      // §十一.1 — selection failure is a HANDOFF_FAILED stage='selection'
      // event, NOT a SPECIALIST_FAILED with empty agentRunId. This avoids
      // creating a phantom empty AgentRun record.
      this.deps.store.apply({
        type: 'HANDOFF_FAILED',
        handoffId,
        stage: 'selection',
        error: `No agent available for capability "${h.requestedCapability}": ${selection.reason ?? 'unknown'}`,
      })
      return null
    }

    this.deps.store.apply({
      type: 'HANDOFF_APPROVED',
      handoffId,
      selectedAgentId: selection.agentId,
    })

    const runPromise = this.runSpecialist(handoffId, selection.agentId)
    this.inFlight.set(handoffId, runPromise)
    try {
      return await runPromise
    } finally {
      this.inFlight.delete(handoffId)
    }
  }

  /** In-flight count for tests / shutdown logic. */
  pendingCount(): number {
    return this.inFlight.size
  }

  /** Release every child harness. */
  async disposeAll(): Promise<void> {
    for (const [, h] of this.specialized) {
      try {
        await h.dispose()
      } catch {
        /* best-effort */
      }
    }
    this.specialized.clear()
  }

  // ── Internals ─────────────────────────────────────────────────────────

  /**
   * Resolve a capability → agent id per next_goal.md §八 rules:
   *   1. Explicit requestedAgentId (if registered).
   *   2. Origin profile's preferredAgentsForHandoff, in declared order.
   *   3. Built-in profile whose id === capability.
   *   4. Registered profile whose id === capability.
   *   5. Fallback: return null with a clear reason.
   */
  private selectAgentForCapability(
    capability: string,
    fromAgentRunId: string,
    explicitAgentId?: string,
  ): { agentId: string | null; reason?: string } {
    if (explicitAgentId) {
      if (!getBuiltinProfile(explicitAgentId) && !PROFILES[explicitAgentId]) {
        return { agentId: null, reason: `requestedAgentId "${explicitAgentId}" not registered` }
      }
      const reason = this.checkAgentBinaryAvailability(explicitAgentId)
      if (reason) return { agentId: null, reason }
      return { agentId: explicitAgentId }
    }

    const fromRun = this.deps.store.getState().agentRuns.find(
      (r) => r.id === fromAgentRunId,
    )
    const fromProfile = fromRun ? resolveProfile(fromRun.profileId) : undefined
    if (fromProfile?.preferredAgentsForHandoff) {
      for (const pref of fromProfile.preferredAgentsForHandoff) {
        if (!getBuiltinProfile(pref) && !PROFILES[pref]) continue
        if (!this.checkAgentBinaryAvailability(pref)) return { agentId: pref }
      }
    }
    if (getBuiltinProfile(capability)) {
      if (!this.checkAgentBinaryAvailability(capability)) return { agentId: capability }
    }
    if (PROFILES[capability]) {
      if (!this.checkAgentBinaryAvailability(capability)) return { agentId: capability }
    }
    return {
      agentId: null,
      reason: `no profile registers capability "${capability}" with all required binaries`,
    }
  }

  /**
   * Returns null when all required binaries for `agentId`'s allowedTools are
   * available; returns a reason string otherwise.
   */
  private checkAgentBinaryAvailability(agentId: string): string | null {
    const profile = getBuiltinProfile(agentId) ?? PROFILES[agentId]
    if (!profile) return `profile "${agentId}" not found`
    const registry = this.deps.parentToolRegistry
    const toolIds = (profile.allowedTools ?? []).filter((id) => registry.has(id))
    if (toolIds.length === 0) return null
    const issues = checkRegistryAvailability(registry, toolIds)
    const realIssues = issues.filter((i) => !i.missingBinaries.includes('__unknown_tool__'))
    if (realIssues.length === 0) return null
    const missing = realIssues.flatMap((i) => i.missingBinaries).join(', ')
    return `agent "${agentId}" missing required binaries: ${missing}`
  }

  private async runSpecialist(
    handoffId: string,
    agentId: string,
  ): Promise<AgentRunResult> {
    const profile = resolveProfile(agentId)
    if (!profile) {
      const err = `No profile for agent "${agentId}"`
      this.deps.store.apply({
        type: 'SPECIALIST_FAILED',
        handoffId,
        agentRunId: '',
        error: err,
      })
      return failedResult(agentId, err)
    }

    // §十一.4 — derive a NARROWED scope for the specialist. The Specialist
    // only needs access to its subtask workspace + the artifacts inherited
    // from the parent handoff. We intersect allowedHosts/allowedDomains
    // with the parent's allowed list and narrow the filesRoot to the
    // subtask directory.
    const narrowedScope = this.narrowSpecialistScope(
      this.deps.parentContext.contestScope,
      handoffId,
    )
    const handle = await this.specialistFactory.create({
      parentContext: this.deps.parentContext,
      parentTaskId: this.deps.parentTaskId,
      handoff: this.deps.store.getState().handoffs.find((h) => h.id === handoffId)!,
      profile,
      dependencies: this.deps.parentDependencies,
      runtimeRenderer: this.deps.runtimeRenderer,
      parentAbortSignal: this.deps.abort.signal,
      subtaskScope: narrowedScope,
      subtaskId: `${this.deps.parentTaskId}/spec_${handoffId.slice(-6)}`,
      cwd: this.deps.cwd,
      sessionsRoot: this.deps.sessionsRoot,
      parentArtifactStore: this.deps.parentArtifactStore,
      parentFindingStore: this.deps.parentFindingStore,
    })
    this.specialized.set(handoffId, handle)
    const handoffRec = this.deps.store.getState().handoffs.find((h) => h.id === handoffId)!

    const agentRunId = `run_${randomBytes(6).toString('hex')}`
    const agentRun: AgentRunRecord = {
      id: agentRunId,
      taskId: this.deps.parentTaskId,
      profileId: profile.id,
      contextTaskId: handle.context.taskId,
      handoffId,
      status: 'running',
      startedAt: Date.now(),
      inheritedArtifactIds: handoffRec.artifactIds,
      inheritedFindingIds: handoffRec.findingIds,
      producedFindingIds: [],
      producedArtifactIds: [],
    }
    this.deps.store.apply({ type: 'AGENT_RUN_STARTED', agentRun })
    this.deps.store.apply({
      type: 'SPECIALIST_STARTED',
      handoffId,
      agentRun: { ...agentRun, status: 'running' },
    })

    let failureError: Error | undefined
    try {
      // Phase 1.7 §十二 — the specialist wrote into its OWN independent
      // stores during this turn. We configure the projector to read from
      // those child stores for this projection pass and copy valid
      // findings/artifacts into the parent.
      const childProjector = this.deps.projector.withChildStores(
        handle.findingStore,
        handle.artifactStore,
      )
      const before = childProjector.captureSnapshot()
      let engineOut:
        | { result: TurnResult; newHistory: OpenAIMessage[] }
        | undefined
      try {
        engineOut = await handle.harness.runTurn(
          `Continue from handoff ${handoffId}: ${handoffRec.objective}`,
          [],
        )
      } catch (err) {
        const wrapped = this.deps.wrapError('specialist turn threw', err)
        failureError = wrapped
        throw wrapped
      }

      if (!engineOut || !engineOut.result.stopped) {
        this.cancelAgentRun(agentRunId, handoffId, 'specialist interrupted')
        return failedResult(profile.id, engineOut?.result.error ?? 'specialist interrupted')
      }
      // §十一.4 — if the specialist's per-handle controller aborted,
      // map the run to 'cancelled' (not 'completed') regardless of the
      // engine's reported success. The LLM call was actually interrupted.
      if (handle.abort.controller.signal.aborted) {
        const reason = handle.abort.controller.signal.reason ?? 'specialist_cancelled'
        this.cancelAgentRun(agentRunId, handoffId, reason)
        return {
          agentRunId,
          profileId: profile.id,
          status: 'cancelled',
          error: reason,
          producedFindingIds: [],
          producedArtifactIds: [],
        }
      }

      // Project the diff into TaskState. The handoffId + agentRunId are
      // forwarded so artifacts produced by the specialist are physically
      // copied into the parent's artifact store with a lineage sidecar
      // entry, and the run-id filtering (§十三.3) actually matches.
      const projection = childProjector.projectDiff(before, {
        producerProfileId: profile.id,
        handoffId,
        agentRunId,
      })
      for (const ev of projection.events) this.deps.store.apply(ev)
      const summary = `inherited ${handoffRec.findingIds.length} findings, ${handoffRec.artifactIds.length} artifacts; produced ${projection.newFindingIds.length} findings + ${projection.newArtifactIds.length} artifacts; turn finished`
      this.deps.store.apply({ type: 'AGENT_RUN_COMPLETED', agentRunId, summary })
      this.deps.store.apply({
        type: 'AGENT_RUN_OUTPUT_RECORDED',
        agentRunId,
        producedFindingIds: projection.newFindingIds,
        producedArtifactIds: projection.newArtifactIds,
      })
      this.deps.store.apply({
        type: 'SPECIALIST_COMPLETED',
        handoffId,
        agentRunId,
        summary,
      })
      return {
        agentRunId,
        profileId: profile.id,
        status: 'completed',
        summary,
        producedFindingIds: projection.newFindingIds,
        producedArtifactIds: projection.newArtifactIds,
      }
    } catch (err) {
      const e = failureError ?? (err instanceof Error ? err : new Error(String(err)))
      this.failAgentRun(agentRunId, handoffId, e.message)
      return failedResult(profile.id, e.message)
    } finally {
      try {
        await handle.dispose()
      } catch {
        /* best-effort */
      }
      this.specialized.delete(handoffId)
    }
  }

  private failAgentRun(agentRunId: string, handoffId: string, error: string): void {
    this.deps.store.apply({ type: 'AGENT_RUN_FAILED', agentRunId, error })
    this.deps.store.apply({ type: 'SPECIALIST_FAILED', handoffId, agentRunId, error })
  }

  private cancelAgentRun(agentRunId: string, handoffId: string, reason: string): void {
    this.deps.store.apply({ type: 'AGENT_RUN_CANCELLED', agentRunId, reason })
    this.deps.store.apply({
      type: 'SPECIALIST_CANCELLED',
      handoffId,
      agentRunId,
      reason,
    })
  }

  /**
   * §十一.4 — narrow the parent's ContestScope for a specialist. The
   * specialist sees a scope restricted to:
   *   - allowedFilesRoot = the specialist's subtask directory
   *   - allowPublicNetwork = parent (inherited)
   *   - allowedHosts / allowedDomains / allowedCidrs / allowedPorts =
   *     inherited as-is (specialist inherits network allow-list)
   */
  private narrowSpecialistScope(
    parentScope: ContestScope,
    handoffId: string,
  ): ContestScope {
    const subtaskDir = join(parentScope.allowedFilesRoot, `spec_${handoffId.slice(-6)}`)
    return {
      ...parentScope,
      allowedFilesRoot: subtaskDir,
    }
  }

  private isTerminal(s: HandoffRecordStatus): boolean {
    return (
      s === 'completed' ||
      s === 'failed' ||
      s === 'cancelled' ||
      s === 'rejected'
    )
  }
}

function resolveProfile(id: string): CapabilityProfile | null {
  return getBuiltinProfile(id) ?? PROFILES[id] ?? null
}

function failedResult(profileId: string, error: string): AgentRunResult {
  return {
    agentRunId: '',
    profileId,
    status: 'failed',
    error,
    producedFindingIds: [],
    producedArtifactIds: [],
  }
}