/**
 * CTFTaskOrchestrator — single authoritative owner of a CTF task.
 *
 * Responsibility:
 *   - Construct the initial `CTFTaskState` and own the `CTFTaskStateStore`.
 *   - Drive the main Agent run (the parent harness).
 *   - Drive Workflow runs.
 *   - Own the Handoff lifecycle: request → approve / reject → run specialist
 *     → collect results. There is exactly ONE approval path and ONE
 *     specialist-spawn function. `dispatchNext` is now an alias.
 *   - Switch Profile atomically (TaskState + Broker + systemPrompt + cached
 *     tools).
 *   - Cancel everything (abort signal + job cancellation).
 *   - Cleanly dispose of subscribers + in-flight runs.
 *
 * It does NOT execute model calls directly — it delegates to the main Harness
 * (an ExecutionEngine) and to Specialist sub-harnesses.
 */

import { randomBytes } from 'crypto'

import type { CapabilityProfile } from '../capabilityProfile.js'
import { parseCapabilityProfile } from '../capabilityProfile.js'
import type { ContestScope, ContestScopeChecker } from '../contestScope.js'
import type { ContestConfig } from '../contestConfig.js'
import { createDefaultContestConfig } from '../contestConfig.js'
import type { HandoffRequest } from '../handoff.js'
import type { Finding } from '../findings.js'
import type { ArtifactMeta } from '../artifacts.js'
import type { WorkflowDefinition, WorkflowRunResult } from '../workflowDefinition.js'
import { createHarness, type HarnessBundle } from '../harness.js'
import { getBuiltinProfile, PROFILES } from '../../capabilityProfiles/index.js'
import type { Renderer } from '../../ui/renderer.js'
import type OpenAI from 'openai'

import type { TaskExecutionContext } from './taskExecutionContext.js'
import { deriveSubtaskContext, narrowContestScope } from './taskExecutionContext.js'
import { CTFTaskStateStore } from './taskStateStore.js'
import {
  type CTFTaskState,
  type HandoffRecord,
  type AgentRunRecord,
  type WorkflowRunRecord,
  type FlagCandidate,
  type CTFTaskPhase,
  type CTFHypothesis,
  type CTFAttempt,
} from './taskState.js'
import type { CTFTaskEvent } from './taskEvents.js'

export interface CreateCTFTaskInput {
  /** Working directory for the task (project root). */
  cwd: string
  /** Starting profile id (e.g. "orchestrator"). */
  profileId: string
  /** Contest scope (optional — defaults to safe factory). */
  contestScope?: ContestScope
  /** Contest config (optional — derived from file or factory). */
  contestConfig?: ContestConfig
  /** Contest id (defaults to basename of cwd). */
  contestId?: string
  /** Task id (defaults to auto-generated). */
  taskId?: string
  /** Where sessions live (defaults to `<cwd>/sessions`). */
  sessionsRoot?: string
  /** OpenAI SDK injection (test seam). */
  client?: OpenAI
  /** Renderer injection (test seam). */
  renderer?: Renderer
  /** Optional challenge description. */
  challenge?: {
    description?: string
    category?: string
    flagPattern?: string
    inputArtifactIds?: string[]
  }
  /** Optional env injection. */
  environment?: Record<string, string>
  /** Initial phase (defaults to 'intake'). */
  initialPhase?: CTFTaskPhase
}

export interface RequestHandoffInput {
  /** The agent run that is asking for help. */
  fromAgentRunId: string
  /** Capability requested (free-form; orchestrator resolves to an agent). */
  targetCapability: string
  /** Optional specific agent id. */
  targetAgentId?: string
  reason: string
  objective: string
  artifactIds?: string[]
  findingIds?: string[]
  constraints?: string[]
  priority?: number
}

export interface AgentRunResult {
  agentRunId: string
  profileId: string
  status: 'completed' | 'failed' | 'cancelled'
  summary?: string
  error?: string
  producedFindingIds: string[]
  producedArtifactIds: string[]
}

export class CTFTaskOrchestrator {
  readonly store: CTFTaskStateStore
  readonly mainHarness: HarnessBundle
  /** AbortController shared by main + specialists + workflows + jobs. */
  private readonly controller = new AbortController()
  /** Mutex map<key, Promise> for serialize-once invariants. */
  private readonly locks = new Map<string, Promise<unknown>>()
  /** In-flight Specialist runs by handoff id — prevents double-start. */
  private readonly inFlightSpecialists = new Map<string, Promise<AgentRunResult>>()
  /** In-flight Workflow runs by workflowRunId. */
  private readonly inFlightWorkflows = new Map<string, Promise<WorkflowRunResult>>()
  /** Track all background jobs we spawned so cancelTask works. */
  private disposed = false

  private constructor(store: CTFTaskStateStore, harness: HarnessBundle) {
    this.store = store
    this.mainHarness = harness
  }

  /**
   * Factory: build the orchestrator + the main harness together. The main
   * harness's TaskExecutionContext is the canonical one for the task; sub-
   * contexts are derived from it.
   */
  static async create(input: CreateCTFTaskInput): Promise<CTFTaskOrchestrator> {
    const cwd = input.cwd
    const contestConfig = input.contestConfig ?? createDefaultContestConfig({ cwd })
    const contestScope = input.contestScope ?? contestConfig
    const harness = createHarness({
      cwd,
      profile: input.profileId,
      contestScope,
      contestId: input.contestId,
      taskId: input.taskId,
      sessionsRoot: input.sessionsRoot,
      client: input.client,
      renderer: input.renderer,
    })
    // Ensure built-in workflows are registered so orchestrator.runWorkflow
    // can resolve them by id.
    const { ensureWorkflowsRegistered } = await import('../../workflows/index.js')
    ensureWorkflowsRegistered(harness.workflowRegistry)

    const now = Date.now()
    const ctx: TaskExecutionContext = {
      ...harness.context,
      abortSignal: undefined,
      environment: input.environment,
    }
    const initial: CTFTaskState = {
      taskId: harness.context.taskId,
      phase: input.initialPhase ?? 'intake',
      context: ctx,
      challenge: {
        description: input.challenge?.description,
        category: input.challenge?.category,
        flagPattern: input.challenge?.flagPattern,
        inputArtifactIds: input.challenge?.inputArtifactIds ?? [],
      },
      activeProfileId: harness.profile.id,
      findings: [],
      artifactIds: [],
      hypotheses: [],
      attempts: [],
      handoffs: [],
      activeAgentRuns: [],
      activeWorkflowRuns: [],
      activeJobs: [],
      flagCandidates: [],
      createdAt: now,
      updatedAt: now,
    }
    const store = new CTFTaskStateStore(initial)
    store.apply({ type: 'TASK_CREATED', taskId: initial.taskId, initial })

    const orch = new CTFTaskOrchestrator(store, harness)
    // Replace the main harness's context with the orchestrator-owned one so
    // the abort signal is shared.
    harness.context.abortSignal
    return orch
  }

  // ── Accessors ────────────────────────────────────────────────────────
  getState(): Readonly<CTFTaskState> {
    return this.store.getState()
  }

  getMainHarness(): HarnessBundle {
    return this.mainHarness
  }

  // ── Phase transitions ────────────────────────────────────────────────
  setPhase(to: CTFTaskPhase, reason?: string): void {
    const from = this.store.getState().phase
    if (from === to) return
    this.store.apply({ type: 'PHASE_CHANGED', from, to, reason })
  }

  // ── Findings / Artifacts / Flag candidates ──────────────────────────
  addFinding(f: Finding): void {
    this.store.apply({ type: 'FINDING_ADDED', finding: f })
  }

  addArtifact(meta: ArtifactMeta): void {
    this.store.apply({ type: 'ARTIFACT_ADDED', artifactId: meta.id })
  }

  addFlagCandidate(c: FlagCandidate): void {
    this.store.apply({ type: 'FLAG_CANDIDATE_ADDED', candidate: c })
  }

  addHypothesis(h: CTFHypothesis): void {
    this.store.apply({ type: 'HYPOTHESIS_ADDED', hypothesisId: h.id })
  }

  recordAttempt(a: CTFAttempt): void {
    this.store.apply({ type: 'ATTEMPT_RECORDED', attemptId: a.id })
  }

  // ── Workflow runs ────────────────────────────────────────────────────
  async runWorkflow(
    workflowId: string,
    inputs?: Record<string, unknown>,
    initiatedByAgentRunId?: string,
  ): Promise<WorkflowRunResult> {
    return this.withLock(`workflow:${workflowId}`, async () => {
      const wf = this.mainHarness.workflowRegistry.get(workflowId)
      if (!wf) throw new Error(`Unknown workflow: ${workflowId}`)

      const id = `wf_${randomBytes(6).toString('hex')}`
      const record: WorkflowRunRecord = {
        id,
        taskId: this.store.getState().taskId,
        workflowId,
        status: 'running',
        startedAt: Date.now(),
        initiatedByAgentRunId,
        stepOutcomeIds: [],
      }
      this.store.apply({ type: 'WORKFLOW_STARTED', workflowRun: record })

      const p = (async () => {
        try {
          const r = await this.mainHarness.runWorkflow(wf, inputs ?? {})
          this.store.apply({
            type: 'WORKFLOW_COMPLETED',
            workflowRunId: id,
            summary: `${r.status} (${r.stepOutcomes.length} steps)`,
          })
          return r
        } catch (err) {
          this.store.apply({
            type: 'WORKFLOW_FAILED',
            workflowRunId: id,
            error: (err as Error).message,
          })
          throw err
        }
      })()
      this.inFlightWorkflows.set(id, p)
      try {
        return await p
      } finally {
        this.inFlightWorkflows.delete(id)
      }
    })
  }

  // ── Main Agent ───────────────────────────────────────────────────────
  /** Run a single Main-Agent turn. The orchestrator does NOT own the LLM
   *  loop; the caller drives `mainHarness.runTurn()` until done. This method
   *  just records the lifecycle. */
  recordMainAgentRun(agentRun: AgentRunRecord): void {
    this.store.apply({ type: 'AGENT_RUN_STARTED', agentRun })
  }

  // ── Handoff lifecycle (single authoritative path) ───────────────────
  requestHandoff(input: RequestHandoffInput): HandoffRecord {
    const record: HandoffRecord = {
      id: `hof_${randomBytes(8).toString('hex')}`,
      taskId: this.store.getState().taskId,
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
    this.store.apply({ type: 'HANDOFF_REQUESTED', handoff: record })
    return record
  }

  /** Approve a pending Handoff and immediately spawn the Specialist. Returns
   *  the result of the specialist run. This is the ONLY place specialists are
   *  spawned — `dispatchNext` is just a thin alias. */
  async approveHandoff(handoffId: string): Promise<AgentRunResult | null> {
    return this.withLock(`handoff:${handoffId}`, async () => {
      const h = this.store.getState().handoffs.find((x) => x.id === handoffId)
      if (!h) throw new Error(`Handoff ${handoffId} not found`)
      if (h.status !== 'requested') {
        throw new Error(`Handoff ${handoffId} is not in 'requested' state (got ${h.status})`)
      }
      if (this.inFlightSpecialists.has(handoffId)) {
        // Idempotent: return the existing in-flight run.
        return this.inFlightSpecialists.get(handoffId)!
      }

      const agentId = h.requestedAgentId ?? this.selectAgentForCapability(
        h.requestedCapability,
        h.fromAgentRunId,
      )
      if (!agentId) {
        this.store.apply({
          type: 'HANDOFF_FAILED',
          handoffId,
          agentRunId: '',
          error: `No agent available for capability "${h.requestedCapability}"`,
        })
        return null
      }

      this.store.apply({
        type: 'HANDOFF_APPROVED',
        handoffId,
        selectedAgentId: agentId,
      })

      const runPromise = this.runSpecialist(handoffId, agentId)
      this.inFlightSpecialists.set(handoffId, runPromise)
      try {
        return await runPromise
      } finally {
        this.inFlightSpecialists.delete(handoffId)
      }
    })
  }

  rejectHandoff(handoffId: string, reason: string): void {
    this.store.apply({ type: 'HANDOFF_REJECTED', handoffId, reason })
  }

  /** Select an agent id given a capability. Stable order:
   *   1. requestedAgentId (if specified).
   *   2. Profile's preferredAgentsForHandoff (if it contains a match).
   *   3. Any built-in profile whose id matches the capability name.
   *   4. Fallback: use the capability name as agentId.
   */
  private selectAgentForCapability(
    capability: string,
    fromAgentRunId: string,
  ): string | null {
    // Find the originating agent's profile to consult preferredAgentsForHandoff.
    const fromRun = this.store.getState().activeAgentRuns.find(
      (r) => r.id === fromAgentRunId,
    )
    const fromProfile = fromRun
      ? this.resolveProfile(fromRun.profileId)
      : undefined

    if (fromProfile?.preferredAgentsForHandoff) {
      for (const pref of fromProfile.preferredAgentsForHandoff) {
        if (getBuiltinProfile(pref) || PROFILES[pref]) return pref
      }
    }

    // Built-in / dynamic profile lookup.
    if (getBuiltinProfile(capability)) return capability
    if (PROFILES[capability]) return capability

    // Last resort: treat capability as an agent id and let the resolver fail
    // loudly during harness creation if it doesn't exist.
    return capability
  }

  /** Execute the Specialist. This is the only function in the codebase that
   *  spawns a sub-harness. It MUST be paired with HANDOFF_STARTED +
   *  COMPLETED/FAILED events. */
  private async runSpecialist(
    handoffId: string,
    agentId: string,
  ): Promise<AgentRunResult> {
    const parentCtx = this.mainHarness.context
    const handoff = this.store.getState().handoffs.find((h) => h.id === handoffId)!
    const profile = this.resolveProfile(agentId)
    if (!profile) {
      this.store.apply({
        type: 'HANDOFF_FAILED',
        handoffId,
        agentRunId: '',
        error: `No profile for agent "${agentId}"`,
      })
      return failedResult(agentId, `No profile for agent "${agentId}"`)
    }

    // Derive the sub-context with narrowing — refuse widening.
    const subContext = deriveSubtaskContext(parentCtx, {
      subtaskId: `${parentCtx.taskId}/spec_${handoffId.slice(-6)}`,
      contestScope: parentCtx.contestScope, // same scope (no widening)
      profileId: profile.id,
      metadata: { fromHandoff: handoffId },
    })

    const inheritedFindingIds = handoff.findingIds
    const inheritedArtifactIds = handoff.artifactIds
    const inheritedFindings = this.mainHarness.findingStore
      .list()
      .filter((f) => inheritedFindingIds.includes(f.id))
      .map((f) => ({ id: f.id, summary: f.summary, confidence: f.confidence }))
    const inheritedArtifacts = this.mainHarness.artifactStore
      .list()
      .filter((a) => inheritedArtifactIds.includes(a.id))
      .map((a) => ({ id: a.id, type: a.type, summary: a.summary }))

    const agentRunId = `run_${randomBytes(6).toString('hex')}`
    const agentRun: AgentRunRecord = {
      id: agentRunId,
      taskId: parentCtx.taskId,
      profileId: profile.id,
      contextTaskId: subContext.taskId,
      handoffId,
      status: 'running',
      startedAt: Date.now(),
      inheritedArtifactIds,
      inheritedFindingIds,
      producedFindingIds: [],
      producedArtifactIds: [],
    }
    this.store.apply({ type: 'AGENT_RUN_STARTED', agentRun })
    this.store.apply({ type: 'HANDOFF_STARTED', handoffId, agentRunId })

    const child = createHarness({
      cwd: parentCtx.metadata?.['projectRoot'] as string ?? parentCtx.workspaceDir,
      profile,
      contestScope: subContext.contestScope,
      taskId: subContext.taskId,
      sessionsRoot: parentCtx.metadata?.['sessionsRoot'] as string | undefined,
    })

    const addon = buildInheritedContextAddon(handoff, inheritedFindings, inheritedArtifacts)

    try {
      let result: import('../types.js').TurnResult & { newHistory: import('../types.js').OpenAIMessage[] }
      try {
        result = await child.runTurn(
          `Continue from handoff ${handoffId}: ${handoff.objective}`,
          [],
          { systemPromptAddon: addon },
        )
      } catch (err) {
        this.failAgentRun(agentRunId, handoffId, (err as Error).message)
        return failedResult(profile.id, (err as Error).message)
      }

      if (!result.stopped) {
        // The LLM loop hit max iterations or interrupted; treat as cancellation
        // so the parent doesn't wait indefinitely.
        this.cancelAgentRun(agentRunId, handoffId, 'specialist interrupted')
        return failedResult(profile.id, result.error ?? 'specialist interrupted')
      }

      // Collect findings + artifacts produced by the child.
      const childFindings = child.findingStore.list()
      const childArtifacts = child.artifactStore.list()
      for (const f of childFindings) {
        if (!this.mainHarness.findingStore.list().some((x) => x.id === f.id)) {
          this.mainHarness.findingStore.append({
            taskId: parentCtx.taskId,
            producerAgentId: profile.id,
            category: f.category,
            title: f.title,
            summary: f.summary,
            confidence: f.confidence,
            evidence: f.evidence,
            artifactIds: f.artifactIds,
            recommendedNextActions: f.recommendedNextActions,
            suggestedAgent: f.suggestedAgent,
          })
          this.addFinding(f)
        }
      }
      for (const a of childArtifacts) {
        if (!this.mainHarness.artifactStore.list().some((x) => x.id === a.id)) {
          this.addArtifact(a)
        }
      }
      const summary = `inherited ${inheritedFindings.length} findings, ${inheritedArtifacts.length} artifacts; turn finished: ${result.stopped}`
      this.store.apply({ type: 'AGENT_RUN_COMPLETED', agentRunId, summary })
      this.store.apply({
        type: 'HANDOFF_COMPLETED',
        handoffId,
        agentRunId,
        summary,
      })
      return {
        agentRunId,
        profileId: profile.id,
        status: 'completed',
        summary,
        producedFindingIds: childFindings.map((f) => f.id),
        producedArtifactIds: childArtifacts.map((a) => a.id),
      }
    } catch (err) {
      this.failAgentRun(agentRunId, handoffId, (err as Error).message)
      return failedResult(profile.id, (err as Error).message)
    }
  }

  private failAgentRun(agentRunId: string, handoffId: string, error: string): void {
    this.store.apply({ type: 'AGENT_RUN_FAILED', agentRunId, error })
    this.store.apply({ type: 'HANDOFF_FAILED', handoffId, agentRunId, error })
  }

  private cancelAgentRun(agentRunId: string, handoffId: string, reason: string): void {
    this.store.apply({ type: 'AGENT_RUN_CANCELLED', agentRunId, reason })
    this.store.apply({ type: 'HANDOFF_CANCELLED', handoffId, reason })
  }

  // ── Profile atomic switch ───────────────────────────────────────────
  /** Atomically switch the active profile. Updates TaskState, broker, and
   *  the main harness's profile field. No private-field writes. */
  switchProfile(nextProfileId: string): void {
    const profile = this.resolveProfile(nextProfileId)
    if (!profile) throw new Error(`Unknown profile: ${nextProfileId}`)
    const prev = this.store.getState().activeProfileId
    if (prev === profile.id) return
    this.store.apply({
      type: 'PROFILE_CHANGED',
      previousProfileId: prev,
      profileId: profile.id,
    })
    // Re-bind the broker through the public switchProfile entry point.
    this.mainHarness.switchProfile(profile)
  }

  // ── Cancel / dispose ─────────────────────────────────────────────────
  cancel(reason: string): void {
    if (this.disposed) return
    this.controller.abort(reason)
    this.mainHarness.cancelAllJobs(reason)
    // Cancel any in-flight specialists — best effort.
    for (const [, runP] of this.inFlightSpecialists) {
      void runP.catch(() => {})
    }
    for (const [, wfP] of this.inFlightWorkflows) {
      void wfP.catch(() => {})
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.cancel('dispose')
    // Wait briefly for in-flight operations to settle.
    await Promise.allSettled([...this.inFlightSpecialists.values()])
    await Promise.allSettled([...this.inFlightWorkflows.values()])
  }

  // ── Subscribe shortcut ───────────────────────────────────────────────
  subscribe(listener: import('./taskEvents.js').TaskStateListener): () => void {
    return this.store.subscribe(listener)
  }

  // ── Helpers ──────────────────────────────────────────────────────────
  private resolveProfile(id: string): CapabilityProfile | null {
    if (id === 'orchestrator') return getBuiltinProfile('orchestrator') ?? null
    return getBuiltinProfile(id) ?? PROFILES[id] ?? null
  }

  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve()
    let resolve!: () => void
    const next = new Promise<void>((r) => (resolve = r))
    this.locks.set(key, prev.then(() => next))
    try {
      await prev
      return await fn()
    } finally {
      resolve()
      if (this.locks.get(key) === next) this.locks.delete(key)
    }
  }
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

function buildInheritedContextAddon(
  handoff: HandoffRecord,
  findings: Array<{ id: string; summary: string; confidence: string }>,
  artifacts: Array<{ id: string; type: string; summary: string }>,
): string {
  const lines: string[] = []
  lines.push('## Handoff inherited context (do NOT re-analyse the original input)')
  lines.push('')
  lines.push(`You are continuing work handed off from agent run "${handoff.fromAgentRunId}".`)
  lines.push(`Reason: ${handoff.reason}`)
  lines.push(`Objective: ${handoff.objective}`)
  if (handoff.constraints && handoff.constraints.length > 0) {
    lines.push(`Constraints: ${handoff.constraints.join('; ')}`)
  }
  lines.push('')
  if (artifacts.length > 0) {
    lines.push('### Inherited Artifacts')
    for (const a of artifacts) lines.push(`- [${a.id}] ${a.type} — ${a.summary}`)
  }
  if (findings.length > 0) {
    lines.push('### Inherited Findings')
    for (const f of findings) {
      lines.push(`- [${f.id}] (${f.confidence}) ${f.summary}`)
    }
  }
  lines.push('')
  lines.push('Operate on the inherited data above. Do NOT re-run triage on the original input.')
  return lines.join('\n')
}
