/**
 * CTFTaskOrchestrator — single authoritative owner of a CTF task.
 *
 * This is the ONLY entry point used by the CLI / REPL / tests for running a
 * CTF task. It composes:
 *
 *   - CTFTaskStateStore            (the state)
 *   - ProfileStore                 (single source of truth for active profile)
 *   - ToolBroker                   (gates every tool call)
 *   - TaskExecutionContext         (workspace + scope + abort)
 *   - HandoffCoordinator           (handoff FSM + specialist spawn)
 *   - SpecialistHarnessFactory     (build child harnesses with full deps)
 *   - TaskStateProjector           (diff findings/artifacts → events)
 *   - BackgroundJobManager         (jobs, subscribed via lifecycle events)
 *   - LinkedAbortController        (parent ↔ child abort chain)
 *
 * It does NOT execute model calls directly — it delegates to the main Harness
 * (ExecutionEngine) and to Specialist sub-harnesses.
 */

import { randomBytes } from 'crypto'

import type { CapabilityProfile } from '../capabilityProfile.js'
import type { ContestScope } from '../contestScope.js'
import type { ContestConfig } from '../contestConfig.js'
import { createDefaultContestConfig } from '../contestConfig.js'
import type { Finding } from '../findings.js'
import type { ArtifactMeta } from '../artifacts.js'
import type { WorkflowRunResult } from '../workflowDefinition.js'
import { createHarness, type HarnessBundle } from '../harness.js'
import { Renderer } from '../../ui/renderer.js'
import type OpenAI from 'openai'
import { getBuiltinProfile, PROFILES } from '../../capabilityProfiles/index.js'

import type { TaskExecutionContext } from './taskExecutionContext.js'
import { CTFTaskStateStore } from './taskStateStore.js'
import { CTFProfileStore } from './profileStore.js'
import { TaskStateProjector } from './taskStateProjector.js'
import { HandoffCoordinator, type RequestHandoffInput } from './handoffCoordinator.js'
import type { AgentRuntimeDependencies } from './agentRuntimeDependencies.js'
import { createLinkedAbortController, type LinkedAbortController } from './linkedAbortController.js'

import type {
  CTFTaskState,
  HandoffRecord,
  AgentRunRecord,
  AgentRunResult,
  WorkflowRunRecord,
  FlagCandidate,
  CTFTaskPhase,
  CTFHypothesis,
  CTFAttempt,
  JobRecord,
} from './taskState.js'

export interface CreateCTFTaskInput {
  cwd: string
  profileId: string
  contestScope?: ContestScope
  contestConfig?: ContestConfig
  contestId?: string
  taskId?: string
  sessionsRoot?: string
  client?: OpenAI
  renderer?: Renderer
  challenge?: {
    description?: string
    category?: string
    flagPattern?: string
    inputArtifactIds?: string[]
  }
  environment?: Record<string, string>
  initialPhase?: CTFTaskPhase
  model?: string
  apiKey?: string
  baseURL?: string
  jobLimits?: { maxPerAgent?: number; maxPerTask?: number; globalTimeoutMs?: number }
}

export class CTFTaskOrchestrator {
  readonly store: CTFTaskStateStore
  readonly mainHarness: HarnessBundle
  readonly profileStore: CTFProfileStore
  readonly projector: TaskStateProjector
  readonly dependencies: AgentRuntimeDependencies
  readonly abort: LinkedAbortController
  readonly handoffCoordinator: HandoffCoordinator

  /** In-flight Workflow runs by workflowRunId. */
  private readonly inFlightWorkflows = new Map<string, Promise<WorkflowRunResult>>()
  private readonly workflowUnsubscribes = new Map<string, () => void>()
  private readonly locks = new Map<string, Promise<unknown>>()
  private disposed = false

  private constructor(
    store: CTFTaskStateStore,
    harness: HarnessBundle,
    profileStore: CTFProfileStore,
    abort: LinkedAbortController,
    dependencies: AgentRuntimeDependencies,
  ) {
    this.store = store
    this.mainHarness = harness
    this.profileStore = profileStore
    this.abort = abort
    this.dependencies = dependencies
    this.projector = new TaskStateProjector({
      findingStore: harness.findingStore,
      artifactStore: harness.artifactStore,
    })
    this.handoffCoordinator = new HandoffCoordinator({
      store,
      parentContext: harness.context,
      parentDependencies: dependencies,
      parentToolRegistry: harness.registry,
      cwd: harness.context.metadata?.['projectRoot'] as string | undefined ?? harness.context.workspaceDir,
      sessionsRoot: harness.context.metadata?.['sessionsRoot'] as string | undefined,
      parentTaskId: harness.context.taskId,
      abort,
      projector: this.projector,
      wrapError: (summary, cause) => this.wrapError(summary, cause),
    })
  }

  /**
   * Assembly step used by `createCTFTaskRuntime` — caller has already built
   * the harness, profile store, abort controller, and dependency bundle.
   * This method only wires the StateStore + challenge + environment.
   *
   * Public callers should prefer `createCTFTaskRuntime` (forth_goal.md §四);
   * this method exists so tests can construct an Orchestrator without
   * setting up the full Runtime.
   */
  static async assemble(args: {
    harness: HarnessBundle
    profileStore: CTFProfileStore
    abort: LinkedAbortController
    dependencies: AgentRuntimeDependencies
    challenge?: CreateCTFTaskInput['challenge']
    environment?: Record<string, string>
  }): Promise<CTFTaskOrchestrator> {
    const { harness, profileStore, abort, dependencies } = args

    const now = Date.now()
    const initial: CTFTaskState = {
      taskId: harness.context.taskId,
      phase: 'intake',
      context: harness.context,
      challenge: {
        description: args.challenge?.description,
        category: args.challenge?.category,
        flagPattern: args.challenge?.flagPattern,
        inputArtifactIds: args.challenge?.inputArtifactIds ?? [],
      },
      activeProfileId: profileStore.getCurrent().id,
      findings: [],
      artifactIds: [],
      hypotheses: [],
      attempts: [],
      handoffs: [],
      agentRuns: [],
      workflowRuns: [],
      jobs: [],
      activeAgentRunIds: [],
      activeWorkflowRunIds: [],
      activeJobIds: [],
      flagCandidates: [],
      createdAt: now,
      updatedAt: now,
    }
    const store = new CTFTaskStateStore(initial)
    store.apply({ type: 'TASK_CREATED', taskId: initial.taskId, initial })

    const orch = new CTFTaskOrchestrator(store, harness, profileStore, abort, dependencies)
    return orch
  }

  static async create(input: CreateCTFTaskInput): Promise<CTFTaskOrchestrator> {
    const cwd = input.cwd
    const contestConfig = input.contestConfig ?? createDefaultContestConfig({ cwd })
    const contestScope = input.contestScope ?? contestConfig

    const profileStore = new CTFProfileStore(resolveProfileById(input.profileId))
    const harness = createHarness({
      cwd,
      profile: profileStore.getCurrent(),
      contestScope,
      contestId: input.contestId,
      taskId: input.taskId,
      sessionsRoot: input.sessionsRoot,
      client: input.client,
      renderer: input.renderer,
      jobLimits: input.jobLimits,
    })
    // Re-bind the broker through the ProfileStore so getProfile/setProfile
    // route through the shared source of truth (§七). Use the public setter —
    // no private-field writes.
    harness.broker.setProfile(profileStore.getCurrent())

    const { ensureWorkflowsRegistered } = await import('../../workflows/index.js')
    ensureWorkflowsRegistered(harness.workflowRegistry)

    const abort = createLinkedAbortController(undefined)

    const dependencies: AgentRuntimeDependencies = {
      client: input.client ?? (harness.broker as unknown as { client?: OpenAI }).client ?? ({} as OpenAI),
      renderer: input.renderer ?? (harness as unknown as { renderer?: Renderer }).renderer ?? (new Renderer() as unknown as Renderer),
      modelConfig: {
        model: input.model ?? process.env['OVOGO_MODEL'] ?? 'gpt-4o',
        apiKey: input.apiKey ?? process.env['OPENAI_API_KEY'] ?? 'test-key',
        baseURL: input.baseURL ?? process.env['OPENAI_BASE_URL'],
      },
      eventLog: harness.eventLog,
    }

    // Re-write the harness context with the real abort signal so Main Agent
    // / Workflow / Tool see it.
    const ctx: TaskExecutionContext = {
      ...harness.context,
      abortSignal: abort.signal,
      profileId: profileStore.getCurrent().id,
      metadata: {
        ...(harness.context.metadata ?? {}),
        projectRoot: cwd,
        sessionsRoot: input.sessionsRoot,
      },
    }
    ;(harness as unknown as { context: TaskExecutionContext }).context = ctx

    const now = Date.now()
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
      activeProfileId: profileStore.getCurrent().id,
      findings: [],
      artifactIds: [],
      hypotheses: [],
      attempts: [],
      handoffs: [],
      agentRuns: [],
      workflowRuns: [],
      jobs: [],
      activeAgentRunIds: [],
      activeWorkflowRunIds: [],
      activeJobIds: [],
      flagCandidates: [],
      createdAt: now,
      updatedAt: now,
    }
    const store = new CTFTaskStateStore(initial)
    store.apply({ type: 'TASK_CREATED', taskId: initial.taskId, initial })

    const orch = new CTFTaskOrchestrator(store, harness, profileStore, abort, dependencies)
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

  // ── Findings / Artifacts / Flag candidates / Hypothesis / Attempt ────
  addFinding(f: Finding): void {
    if (this.store.getState().findings.some((x) => x.id === f.id)) return
    this.store.apply({ type: 'FINDING_ADDED', finding: f })
  }

  addArtifact(meta: ArtifactMeta): void {
    this.store.apply({ type: 'ARTIFACT_ADDED', artifactId: meta.id })
  }

  addFlagCandidate(c: FlagCandidate): void {
    this.store.apply({ type: 'FLAG_CANDIDATE_ADDED', candidate: c })
  }

  addHypothesis(h: CTFHypothesis): void {
    this.store.apply({ type: 'HYPOTHESIS_ADDED', hypothesis: h })
  }

  updateHypothesis(id: string, patch: Partial<CTFHypothesis>): void {
    this.store.apply({ type: 'HYPOTHESIS_UPDATED', hypothesisId: id, patch })
  }

  recordAttempt(a: CTFAttempt): void {
    this.store.apply({ type: 'ATTEMPT_RECORDED', attempt: a })
  }

  updateAttempt(id: string, patch: Partial<CTFAttempt>): void {
    this.store.apply({ type: 'ATTEMPT_UPDATED', attemptId: id, patch })
  }

  /** Mirror a BackgroundJob lifecycle event into the TaskState. Called by
   *  the projector wired up in `createCTFTaskRuntime`. */
  recordJobStarted(job: JobRecord): void {
    this.store.apply({ type: 'JOB_RECORDED', job })
  }

  recordJobUpdated(job: JobRecord): void {
    this.store.apply({
      type: 'JOB_UPDATED',
      jobId: job.id,
      patch: job,
    })
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
      const currentProfileId = this.profileStore.getCurrent().id
      const record: WorkflowRunRecord = {
        id,
        taskId: this.store.getState().taskId,
        workflowId,
        status: 'running',
        startedAt: Date.now(),
        initiatedByAgentRunId,
        stepOutcomeIds: [],
        profileId: currentProfileId,
      }
      this.store.apply({ type: 'WORKFLOW_STARTED', workflowRun: record })

      // Subscribe to terminal events so we can finalise the record cleanly.
      const off = this.store.subscribe((ev) => {
        if (ev.type === 'JOB_RECORDED' && ev.job.workflowRunId === id) {
          // No-op — the global lifecycle handler already mirrors into jobs[].
        }
      })
      this.workflowUnsubscribes.set(id, off)

      const before = this.projector.captureSnapshot()
      const p = (async () => {
        try {
          const r = await this.mainHarness.runWorkflow(wf, inputs ?? {})
          // Project any Findings/Artifacts emitted by workflow steps.
          const projection = this.projector.projectDiff(before, {
            producerProfileId: currentProfileId,
          })
          for (const ev of projection.events) this.store.apply(ev)
          this.store.apply({
            type: 'WORKFLOW_COMPLETED',
            workflowRunId: id,
            summary: `${r.status} (${r.stepOutcomes.length} steps, ${projection.newFindingIds.length} new findings, ${projection.newArtifactIds.length} new artifacts)`,
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
        const sub = this.workflowUnsubscribes.get(id)
        if (sub) sub()
        this.workflowUnsubscribes.delete(id)
      }
    })
  }

  // ── Main Agent ───────────────────────────────────────────────────────
  async runMainAgent(
    userMessage: string,
    history: import('../types.js').OpenAIMessage[] = [],
  ): Promise<AgentRunResult> {
    const agentRunId = `run_${randomBytes(6).toString('hex')}`
    const profileId = this.profileStore.getCurrent().id
    const agentRun: AgentRunRecord = {
      id: agentRunId,
      taskId: this.store.getState().taskId,
      profileId,
      contextTaskId: this.store.getState().context.taskId,
      status: 'running',
      startedAt: Date.now(),
      inheritedArtifactIds: [],
      inheritedFindingIds: [],
      producedFindingIds: [],
      producedArtifactIds: [],
    }
    this.store.apply({ type: 'AGENT_RUN_STARTED', agentRun })
    const before = this.projector.captureSnapshot()
    try {
      const r = await this.mainHarness.runTurn(userMessage, history)
      const projection = this.projector.projectDiff(before, { producerProfileId: profileId })
      for (const ev of projection.events) this.store.apply(ev)
      const summary = `main agent turn finished: ${r.reason}; +${projection.newFindingIds.length} findings +${projection.newArtifactIds.length} artifacts`
      this.store.apply({ type: 'AGENT_RUN_COMPLETED', agentRunId, summary })
      return {
        agentRunId,
        profileId,
        status: 'completed',
        summary,
        producedFindingIds: projection.newFindingIds,
        producedArtifactIds: projection.newArtifactIds,
      }
    } catch (err) {
      const msg = (err as Error).message
      this.store.apply({ type: 'AGENT_RUN_FAILED', agentRunId, error: msg })
      return {
        agentRunId,
        profileId,
        status: 'failed',
        error: msg,
        producedFindingIds: [],
        producedArtifactIds: [],
      }
    }
  }

  recordMainAgentRun(agentRun: AgentRunRecord): void {
    this.store.apply({ type: 'AGENT_RUN_STARTED', agentRun })
  }

  // ── Handoff lifecycle ────────────────────────────────────────────────
  requestHandoff(input: RequestHandoffInput): HandoffRecord {
    return this.handoffCoordinator.request(input)
  }

  async approveHandoff(handoffId: string): Promise<AgentRunResult | null> {
    return this.handoffCoordinator.approveAndRun(handoffId)
  }

  rejectHandoff(handoffId: string, reason: string): void {
    this.handoffCoordinator.reject(handoffId, reason)
  }

  cancelHandoff(handoffId: string, reason: string): void {
    this.handoffCoordinator.cancel(handoffId, reason)
  }

  // ── Profile atomic switch ───────────────────────────────────────────
  switchProfile(nextProfileId: string): void {
    const profile = resolveProfileById(nextProfileId)
    if (!profile) throw new Error(`Unknown profile: ${nextProfileId}`)
    const prev = this.store.getState().activeProfileId
    if (prev === profile.id) return
    // 1. Atomic switch in the ProfileStore (every reader observes it).
    this.profileStore.switchTo(profile)
    // 2. Publish the TaskState event so the audit log reflects it.
    this.store.apply({
      type: 'PROFILE_CHANGED',
      previousProfileId: prev,
      profileId: profile.id,
    })
    // 3. Re-publish through the broker's public setter (no private writes).
    this.mainHarness.broker.setProfile(profile)
  }

  // ── Cancel / dispose ─────────────────────────────────────────────────
  async cancel(reason: string): Promise<void> {
    if (this.disposed) return
    this.abort.controller.abort(reason)
    this.mainHarness.cancelAllJobs(reason)
    for (const [, runP] of this.inFlightWorkflows) {
      void runP.catch(() => {})
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.cancel('dispose')
    this.abort.unlink()
    await this.handoffCoordinator.disposeAll()
    await Promise.allSettled([...this.inFlightWorkflows.values()])
  }


  // ── Subscribe shortcut ───────────────────────────────────────────────
  subscribe(listener: import('./taskEvents.js').TaskStateListener): () => void {
    return this.store.subscribe(listener)
  }

  // ── Helpers ──────────────────────────────────────────────────────────
  private wrapError(userSummary: string, cause: unknown): Error {
    const msg = cause instanceof Error ? cause.message : String(cause)
    return new Error(`${userSummary}: ${msg}`, { cause: cause instanceof Error ? cause : new Error(msg) })
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

function resolveProfileById(id: string): CapabilityProfile {
  const found = getBuiltinProfile(id) ?? PROFILES[id]
  if (!found) throw new Error(`Unknown profile: ${id}`)
  return found
}