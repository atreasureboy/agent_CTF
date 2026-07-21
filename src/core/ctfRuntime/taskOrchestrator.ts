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

import type { TaskStateListener } from './taskEvents.js'

import type { CapabilityProfile } from '../capabilityProfile.js'
import type { ContestScope } from '../contestScope.js'
import type { ContestConfig } from '../contestConfig.js'
import { createDefaultContestConfig } from '../contestConfig.js'
import type { OpenAIMessage } from '../types.js'
import type { Finding } from '../findings.js'
import type { ArtifactMeta } from '../artifacts.js'
import type { WorkflowRunResult } from '../workflowDefinition.js'
import { createHarness, type HarnessBundle } from '../harness.js'
import { Renderer } from '../../ui/renderer.js'
import type OpenAI from 'openai'
import { getBuiltinProfile, PROFILES } from '../../capabilityProfiles/index.js'

import type { TaskExecutionContext } from './taskExecutionContext.js'
import { CTFTaskStateStore } from './taskStateStore.js'
import { CTFProfileStore, type ProfileStore } from './profileStore.js'
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
  private readonly locks = new Map<string, { promise: Promise<unknown>; abort: AbortController }>()
  /** Phase 1.7 §八 — track Main Agent runs too so dispose/cancel can await them. */
  private readonly inFlightAgentRuns = new Map<string, Promise<AgentRunResult>>()
  /** Phase 1.7 §八.1 — proper state machine: active | cancelling | cancelled | disposing | disposed. */
  private lifecycleState: 'active' | 'cancelling' | 'cancelled' | 'disposing' | 'disposed' = 'active'

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
      parentArtifactStore: harness.artifactStore,
      parentArtifactRoot: harness.taskWorkspace.paths.root,
    })
    this.handoffCoordinator = new HandoffCoordinator({
      store,
      parentContext: harness.context,
      parentDependencies: dependencies,
      parentToolRegistry: harness.registry,
      parentArtifactStore: harness.artifactStore,
      parentFindingStore: harness.findingStore,
      cwd: harness.context.metadata?.['projectRoot'] as string | undefined ?? harness.context.workspaceDir,
      sessionsRoot: harness.context.metadata?.['sessionsRoot'] as string | undefined,
      parentTaskId: harness.context.taskId,
      abort,
      projector: this.projector,
      wrapError: (summary, cause) => this.wrapError(summary, cause),
      runtimeRenderer: harness.renderer,
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
  static assemble(args: {
    harness: HarnessBundle
    profileStore: CTFProfileStore
    abort: LinkedAbortController
    dependencies: AgentRuntimeDependencies
    challenge?: CreateCTFTaskInput['challenge']
    environment?: Record<string, string>
  }): CTFTaskOrchestrator {
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
    // Phase 1.7 §七 — this static method is the second Runtime assembly
    // path. We delegate to `createCTFTaskRuntime` so there is exactly ONE
    // real assembly implementation. The static still exists only for
    // backwards compatibility with tests that already call it; new code
    // should use `createCTFTaskRuntime` directly.
    const { createCTFTaskRuntime } = await import('./createCTFTaskRuntime.js')
    const { createHarness } = await import('../harness.js')
    const { Renderer } = await import('../../ui/renderer.js')
    const client = input.client ?? ({ chat: { completions: { create: () => { throw new Error('test: no LLM') } } } } as unknown as import('openai').default)
    // Phase 1.7 — keep the legacy "no renderer → runMainAgent fails" contract.
    // If the caller did not supply a renderer, we synthesise one BUT
    // remember it is a default-fake so runMainAgent can short-circuit.
    const isExplicitRenderer = !!input.renderer
    const renderer = input.renderer ?? new Renderer()
    const runtime = await createCTFTaskRuntime({
      cwd: input.cwd,
      profileId: input.profileId,
      contestConfig: input.contestConfig,
      contestScope: input.contestScope,
      contestId: input.contestId,
      taskId: input.taskId,
      sessionsRoot: input.sessionsRoot,
      client,
      renderer,
      modelConfig: input.apiKey || input.model || input.baseURL
        ? { model: input.model ?? 'gpt-4o', apiKey: input.apiKey ?? '', baseURL: input.baseURL }
        : { model: 'gpt-4o', apiKey: 'test-key', baseURL: undefined },
      mode: 'llm',
      jobLimits: input.jobLimits,
    })
    if (!isExplicitRenderer) {
      // Replace the synthesised renderer with undefined so runMainAgent's
      // explicit-missing check fires correctly. We only null the
      // orchestrator's own dependency record (which runMainAgent reads);
      // the Runtime itself keeps the fake renderer for any code path that
      // does not gate on its presence.
      ;(runtime.dependencies as { renderer?: unknown }).renderer = undefined
    }
    if (input.initialPhase && input.initialPhase !== 'intake') {
      runtime.orchestrator.setPhase(input.initialPhase, 'test override')
    }
    void createHarness
    void Renderer
    return runtime.orchestrator
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
          if (r.status === 'cancelled') {
            // §九 — cancel path emits WORKFLOW_CANCELLED so the run record
            // reflects the actual outcome (not 'completed').
            this.store.apply({
              type: 'WORKFLOW_CANCELLED',
              workflowRunId: id,
              reason: 'workflow cancelled via parent signal',
            })
          } else {
            this.store.apply({
              type: 'WORKFLOW_COMPLETED',
              workflowRunId: id,
              summary: `${r.status} (${r.stepOutcomes.length} steps, ${projection.newFindingIds.length} new findings, ${projection.newArtifactIds.length} new artifacts)`,
            })
          }
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
    history: OpenAIMessage[] = [],
  ): Promise<AgentRunResult> {
    // Phase 1.7 §七 — workflow-only mode refuses LLM calls explicitly.
    // The renderer dependency check is delegated to the harness; here we
    // short-circuit when the harness cannot satisfy the requirement so the
    // AgentRun record reflects a clean failed state.
    const profileId = this.profileStore.getCurrent().id
    if (!this.dependencies.renderer || !this.dependencies.client) {
      const agentRunId = `run_${randomBytes(6).toString('hex')}`
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
      const msg = 'runMainAgent requires a renderer + OpenAI client; workflow-only mode cannot run LLM tasks'
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
    const agentRunId = `run_${randomBytes(6).toString('hex')}`
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
    // Phase 1.7 §八.2 — track this Main Agent run so cancel() and dispose()
    // can await its settlement.
    const runP = (async () => {
      try {
        const r = await this.mainHarness.runTurn(userMessage, history)
        const projection = this.projector.projectDiff(before, { producerProfileId: profileId })
        for (const ev of projection.events) this.store.apply(ev)
        this.store.apply({
          type: 'AGENT_RUN_OUTPUT_RECORDED',
          agentRunId,
          producedFindingIds: projection.newFindingIds,
          producedArtifactIds: projection.newArtifactIds,
        })
        const summary = `main agent turn finished: ${r.result.reason}; +${projection.newFindingIds.length} findings +${projection.newArtifactIds.length} artifacts`
        this.store.apply({ type: 'AGENT_RUN_COMPLETED', agentRunId, summary })
        return {
          agentRunId,
          profileId,
          status: 'completed' as const,
          summary,
          producedFindingIds: projection.newFindingIds,
          producedArtifactIds: projection.newArtifactIds,
        }
      } catch (err) {
        const msg = (err as Error).message
        // Phase 1.7 §十七 — map abort to cancelled rather than failed so
        // the run reflects the actual termination reason.
        if (this.abort.signal.aborted) {
          this.store.apply({ type: 'AGENT_RUN_CANCELLED', agentRunId, reason: msg })
          return {
            agentRunId,
            profileId,
            status: 'cancelled' as const,
            error: msg,
            producedFindingIds: [],
            producedArtifactIds: [],
          }
        }
        this.store.apply({ type: 'AGENT_RUN_FAILED', agentRunId, error: msg })
        return {
          agentRunId,
          profileId,
          status: 'failed' as const,
          error: msg,
          producedFindingIds: [],
          producedArtifactIds: [],
        }
      }
    })()
    this.inFlightAgentRuns.set(agentRunId, runP)
    try {
      return await runP
    } finally {
      this.inFlightAgentRuns.delete(agentRunId)
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
  /**
   * Cancel the entire task:
   *   1. Abort the Task-level AbortController → propagates to engine, workflows,
   *      tools, jobs, and any running specialist.
   *   2. Cancel all BackgroundJobs directly.
   *   3. Cancel all in-flight handoffs (sends HANDOFF_CANCELLED for each active
   *      handoff, then awaits the running specialist promise — abort signal
   *      already wired to child context).
   *   4. Cancel all in-flight workflows (engine returns status='cancelled' once
   *      signal fires → reducer records WORKFLOW_CANCELLED).
   *   5. Fire TASK_COMPLETED with status='cancelled' so phase converges to
   *      'cancelled' and state.completion is populated.
   *
   * Idempotent: a second cancel() with the task already cancelled (or
   * disposed) is a no-op.
   */
  async cancel(reason: string): Promise<void> {
    // Phase 1.7 §八.1 — 5-state lifecycle: active → cancelling → cancelled
    // (then disposed via dispose()). Idempotent.
    if (this.lifecycleState !== 'active') return
    this.lifecycleState = 'cancelling'

    // 1. Abort the Task-level signal — propagates everywhere.
    this.abort.controller.abort(reason)

    // 2. Cancel background jobs (they emit their own JOB_CANCELLED events).
    this.mainHarness.cancelAllJobs(reason)

    // 3. Cancel in-flight handoffs / specialists. cancelAll sends
    //    HANDOFF_CANCELLED for every non-terminal handoff and awaits the
    //    specialist promise so dispose can run cleanly.
    await this.handoffCoordinator.cancelAll(reason)

    // 4. Touch every in-flight workflow — abort signal already propagates
    //    through the workflow runner, the engine will resolve the workflow
    //    promise with status='cancelled', and our `runWorkflow` wrapper
    //    emits WORKFLOW_CANCELLED.
    for (const [, runP] of this.inFlightWorkflows) {
      void runP.catch(() => {})
    }

    // 5. Wait for in-flight Main Agent runs to settle (they see the abort
    //    signal and throw / short-circuit).
    await Promise.allSettled([...this.inFlightAgentRuns.values()])

    // 6. Converge to 'cancelled'.
    this.lifecycleState = 'cancelled'
    try {
      this.store.apply({
        type: 'TASK_COMPLETED',
        status: 'cancelled',
        reason,
      })
    } catch {
      // TaskAlreadyCompletedError — the task finished before cancel landed.
    }
  }

  async dispose(): Promise<void> {
    // Phase 1.7 §八.1 — set `disposing` BEFORE cancel() so cancel() does
    // not see a `disposed` flag and skip work.
    if (this.lifecycleState === 'disposed' || this.lifecycleState === 'disposing') return
    this.lifecycleState = 'disposing'
    try {
      await this.cancel('dispose')
      this.abort.unlink()
      await this.handoffCoordinator.disposeAll()
      await Promise.allSettled([
        ...this.inFlightWorkflows.values(),
        ...this.inFlightAgentRuns.values(),
      ])
    } finally {
      this.lifecycleState = 'disposed'
    }
  }


  // ── Subscribe shortcut ───────────────────────────────────────────────
  subscribe(listener: TaskStateListener): () => void {
    return this.store.subscribe(listener)
  }

  // ── Helpers ──────────────────────────────────────────────────────────
  private wrapError(userSummary: string, cause: unknown): Error {
    const msg = cause instanceof Error ? cause.message : String(cause)
    return new Error(`${userSummary}: ${msg}`, { cause: cause instanceof Error ? cause : new Error(msg) })
  }

  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    // Phase 1.7 §九 — proper key lock. Each key holds the in-flight Promise
    // for that key; the next caller awaits it before running. After the
    // current operation resolves (success or failure), the Map entry is
    // removed so long-running sessions do not leak. Errors in `fn` do not
    // prevent cleanup. If the lock-holding operation is aborted before it
    // resolves, the abort propagates to the queued waiters via the
    // caller's own signal handling.
    type LockState = { promise: Promise<unknown>; abort: AbortController }
    const prev = this.locks.get(key) as LockState | undefined
    const myAbort = new AbortController()
    const myPromise = (async () => {
      if (prev) {
        try {
          await prev.promise
        } catch {
          // The holder failed; we still run our operation.
        }
      }
      if (myAbort.signal.aborted) throw new Error(`lock ${key} aborted before run`)
    })()
    const state: LockState = { promise: myPromise, abort: myAbort }
    this.locks.set(key, state)
    try {
      await myPromise
      return await fn()
    } finally {
      myAbort.abort()
      // Only clear the entry if we still own it (no one else queued after
      // us and overwrote it). Race-safe in single-threaded JS.
      if (this.locks.get(key) === state) this.locks.delete(key)
    }
  }
}

function resolveProfileById(id: string): CapabilityProfile {
  const found = getBuiltinProfile(id) ?? PROFILES[id]
  if (!found) throw new Error(`Unknown profile: ${id}`)
  return found
}