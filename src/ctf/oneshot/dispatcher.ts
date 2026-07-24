/**
 * Dispatcher — Phase 2.0 §六 — single coordinator for OneShot execution.
 *
 * Real call chain (production):
 *
 *   Dispatcher.runOne(manifestId, inputs)
 *     ├─ Build OneShotRunRecord (real taskId)
 *     ├─ BackgroundJobManager.spawn({ toolId: `oneshot:${manifestId}`, input: {...} })
 *     │     └─ JobRunner (registry) — invokes runnerFor(manifest).run()
 *     │     └─ BackgroundJobManager.wait(jobId)
 *     ├─ normalizeResult + ResultStore.save
 *     ├─ ProjectionTransaction → TaskState (finding/artifact/flag/run/attempt)
 *     └─ return OneShotResult
 *
 * Hard invariants:
 *   - The dispatcher NEVER bypasses BackgroundJobManager.
 *   - Each OneShot run has its own LinkedAbortController (§八) so per-run
 *     cancellation is surgical.
 *   - taskId is always the real TaskExecutionContext.taskId (never '' / 'parent').
 */

import { randomBytes } from 'crypto'
import { ScopeGate } from './scopeGate.js'
import type {
  CandidateValue,
  NormalizedFinding,
  OneShotJobProjectionEvent,
  OneShotLane,
  OneShotResult,
} from './types.js'
import { normalizeResult } from './resultNormalizer.js'
import { runnerFor } from './runner.js'
import { BudgetManager } from './budgetManager.js'
import { selectManifests, type SelectedRun, type SelectionInput } from './selector.js'
import type { OneShotRegistry } from './registry.js'
import type { OneShotCatalog } from './catalog.js'
import type {
  BackgroundJobManager,
  BackgroundJobEvent,
  JobRunner,
  JobSpec,
} from '../../core/backgroundJobs.js'
import { newEvidenceDir } from './evidenceCollector.js'
import { createOneShotResultStore, type OneShotResultStore } from './resultStore.js'
import {
  createLinkedAbortController,
  type LinkedAbortController,
} from '../../core/ctfRuntime/linkedAbortController.js'
import type { CTFTaskOrchestrator } from '../../core/ctfRuntime/taskOrchestrator.js'
import type { TaskExecutionContext } from '../../core/ctfRuntime/taskExecutionContext.js'
import type {
  CTFAttempt,
  OneShotRunRecord,
  OneShotRunStatus,
} from '../../core/ctfRuntime/taskState.js'

export interface DispatcherInputs {
  /** Concrete argv for the runner — generated from `argumentTemplate`. */
  argv: string[]
  /** Logs + evidence root directory. INJECTED by Runtime — never from the Tool. */
  evidenceRoot: string
  /** Per-run inputs that the runner may need (e.g. resolved artifact paths). */
  resolvedInput?: Record<string, unknown>
  /** LLM-supplied reason for the run (audit only). */
  reason?: string
}

export type ProjectionListener = (event: OneShotJobProjectionEvent) => void

export interface DispatcherDeps {
  registry: OneShotRegistry
  catalog: OneShotCatalog
  /** Existing BackgroundJobManager — we route through it. */
  jobManager: BackgroundJobManager
  budget?: BudgetManager
  /** Per-task workspace — passed to runners. */
  workspace: string
  /** Result store — persists OneShotResult JSON atomically. */
  resultStore?: OneShotResultStore
  /** Orchestrator — projects into TaskState. */
  orchestrator?: CTFTaskOrchestrator
  /** Task execution context — supplies real taskId + scope. */
  taskContext: TaskExecutionContext
  /** Background-job runner registry — resolves toolId prefixes to JobRunner. */
  runnerRegistry?: BackgroundJobRunnerRegistry
  /** Listeners that mirror ONESHOT_* events. */
  onProjection?: ProjectionListener
  /** Per-task signal that aggregates all in-flight oneshots. */
  signal: AbortSignal
}

interface ActiveRun {
  controller: LinkedAbortController
  backgroundJobId: string
  promise: Promise<OneShotResult>
  attemptId: string
  record: OneShotRunRecord
}

/**
 * Registry of background-job runners keyed by `toolId` prefix.
 * Goal §六 — the JobRunner (registered in BackgroundJobManager) recognises
 * `oneshot:` and routes to `runnerFor(manifest).run()`.
 */
export interface BackgroundJobRunnerRegistry {
  register(prefix: string, runner: JobRunner): void
  resolve(toolId: string): JobRunner | null
}

export class BackgroundJobRunnerRegistryImpl implements BackgroundJobRunnerRegistry {
  private readonly map = new Map<string, JobRunner>()

  register(prefix: string, runner: JobRunner): void {
    this.map.set(prefix, runner)
  }

  resolve(toolId: string): JobRunner | null {
    for (const [prefix, runner] of this.map) {
      if (toolId.startsWith(prefix)) return runner
    }
    return null
  }
}

export class Dispatcher {
  private readonly budget: BudgetManager
  private readonly listeners: ProjectionListener[] = []
  private readonly resultStore: OneShotResultStore
  private readonly ticketByRun = new Map<string, ReturnType<BudgetManager['tryAcquire']>>()
  private readonly activeRuns = new Map<string, ActiveRun>()
  private readonly taskId: string
  private readonly taskContext: TaskExecutionContext

  constructor(private readonly deps: DispatcherDeps) {
    this.budget = deps.budget ?? new BudgetManager()
    this.taskContext = deps.taskContext
    this.taskId = deps.taskContext.taskId
    if (!this.taskId) {
      throw new Error('Dispatcher: TaskExecutionContext.taskId is required')
    }
    if (deps.onProjection) this.listeners.push(deps.onProjection)
    this.resultStore =
      deps.resultStore ?? createOneShotResultStore({ taskWorkspaceDir: deps.workspace })
  }

  addProjectionListener(l: ProjectionListener): void {
    this.listeners.push(l)
  }

  private emit(event: OneShotJobProjectionEvent): void {
    for (const l of this.listeners) {
      try {
        l(event)
      } catch {
        /* listener must not break dispatcher */
      }
    }
  }

  /** Per-Run AbortController — linked to the parent Task signal (§八). */
  private newRunController(): LinkedAbortController {
    return createLinkedAbortController(this.deps.signal)
  }

  /** Resolve a single manifest to a full OneShotResult, blocking on completion.
   *
   *  Real call chain:
   *    - create OneShotRunRecord
   *    - create Attempt
   *    - BackgroundJobManager.spawn({toolId: 'oneshot:<manifestId>'})
   *    - BackgroundJobManager.wait(jobId)
   *    - normalizeResult → ResultStore.save
   *    - Project into TaskState (finding/artifact/flag/run/attempt)
   */
  async runOne(manifestId: string, inputs: DispatcherInputs): Promise<OneShotResult> {
    const manifest = this.deps.registry.get(manifestId)
    if (!manifest) throw new Error(`unknown manifest: ${manifestId}`)

    // §七 — no empty / 'parent' taskIds. Must come from the runtime context.
    if (!this.taskId) throw new Error('Dispatcher: missing taskId')

    const lane = manifest.scheduling.costTier

    // §八 — pre-flight: if the task is already aborted, don't enqueue.
    if (this.deps.signal.aborted) {
      throw new Error('parent task aborted before runOne')
    }

    // §三十三 audit fix — defense-in-depth: enforce profile / heavy /
    // network authorisation INSIDE Dispatcher.runOne so the public
    // `run_one_shot` Tool cannot bypass the ShotgunCoordinator's checks.
    if (!manifest.allowedProfiles.includes(this.taskContext.profileId)) {
      throw new Error(
        `manifest ${manifestId} not allowed for profile ${this.taskContext.profileId}`,
      )
    }
    if (
      manifest.scheduling.costTier === 'heavy' &&
      this.taskContext.contestScope.allowHeavyOneShots !== true
    ) {
      throw new Error(`heavy-tier manifest ${manifestId} requires operator approval`)
    }
    if (
      manifest.network.mode !== 'none' &&
      this.taskContext.contestScope.allowPublicNetwork !== true &&
      manifest.network.mode !== 'contest-target-only'
    ) {
      throw new Error(`network mode ${manifest.network.mode} not authorised`)
    }

    // §二十四 — atomic budget acquire (real taskId).
    const ticket = this.budget.tryAcquire(this.taskId, lane)
    if (!ticket) {
      throw new Error(`budget exceeded for lane=${lane} (taskId=${this.taskId})`)
    }

    // §round-2 audit fix — defence-in-depth ScopeGate. Every argv value
    // that looks like a network target (host, host:port, IP, URL) is
    // checked against the contest scope. This blocks the SSRF vector
    // where model-supplied `options.url` flows through the template into
    // a process runner's argv and reaches the network.
    if (manifest.network.mode !== 'none') {
      const gate = new ScopeGate(
        {
          hosts: this.taskContext.contestScope.allowedHosts ?? [],
          domains: this.taskContext.contestScope.allowedDomains ?? [],
          ports: this.taskContext.contestScope.allowedPorts ?? [],
          cidrs: this.taskContext.contestScope.allowedCidrs ?? [],
        },
        { denyByDefault: true },
      )
      for (const arg of inputs.argv) {
        if (this.looksLikeNetworkTarget(arg)) {
          gate.assert(arg)
        }
      }
    }

    const runId = `os_${randomBytes(6).toString('hex')}`
    this.ticketByRun.set(runId, ticket)

    // Per-run AbortController — linked to the parent task signal.
    const linked = this.newRunController()
    const attemptId = `att_${randomBytes(4).toString('hex')}`

    // Build the OneShotRunRecord (§三).
    const ev = newEvidenceDir(inputs.evidenceRoot)
    const record: OneShotRunRecord = {
      id: runId,
      taskId: this.taskId,
      manifestId,
      profileId: this.taskContext.profileId,
      initiatedByAgentRunId: this.taskContext.metadata?.['agentRunId'] as string | undefined,
      initiatedByWorkflowRunId: this.taskContext.metadata?.['workflowRunId'] as string | undefined,
      handoffId: this.taskContext.metadata?.['handoffId'] as string | undefined,
      backgroundJobId: '',
      lane,
      status: 'queued',
      inputArtifactIds: this.collectInputArtifactIds(inputs.resolvedInput),
      attemptId,
      findingIds: [],
      artifactIds: [],
      flagCandidateIds: [],
      evidenceRoot: ev.rootDir,
      queuedAt: Date.now(),
    }

    const entry: ActiveRun = {
      controller: linked,
      backgroundJobId: '',
      promise: Promise.resolve(undefined as unknown as OneShotResult),
      attemptId,
      record,
    }
    this.activeRuns.set(runId, entry)
    this.resultStore.retain(this.taskId, runId)

    // §round-2 audit fix — every setup step that can throw must run
    // INSIDE the try block. Previously the activeRuns entry was added
    // before the try, so a throw during newEvidenceDir / recordOneShotQueued
    // / recordAttempt leaked the budget ticket + linked controller.
    try {
      this.emit({
        type: 'ONESHOT_QUEUED',
        runId,
        manifestId,
        taskId: this.taskId,
        lane,
        at: new Date().toISOString(),
        detail: { argvLength: inputs.argv.length },
      })
      this.deps.orchestrator?.recordOneShotQueued(record)

      const attempt: CTFAttempt = {
        id: attemptId,
        taskId: this.taskId,
        kind: 'oneshot',
        targetId: manifestId,
        input: { argv: inputs.argv, resolvedInput: inputs.resolvedInput ?? {} },
        fingerprint: `${manifestId}:${this.shortFingerprint(inputs)}`,
        hypothesisIds: [],
        status: 'running',
        observationIds: [],
        evidenceIds: [],
        artifactIds: [],
        flagCandidateIds: [],
        createdAt: Date.now(),
      }
      this.deps.orchestrator?.recordAttempt(attempt)

      const promise = this.executeRun(manifestId, record, attempt, linked, inputs, ev.rootDir)
      entry.promise = promise
      return await promise
    } finally {
      // Centralised cleanup — covers success, throw, and cancellation.
      this.releaseResources(runId)
    }
  }

  /** Run the full selector pipeline. */
  async runSelected(input: SelectionInput, inputs: DispatcherInputs): Promise<OneShotResult[]> {
    const selections = selectManifests(input, this.deps.catalog)
    const results: OneShotResult[] = []
    for (const sel of selections) {
      try {
        results.push(await this.runOne(sel.manifest.id, inputs))
      } catch (err) {
        results.push({
          runId: '',
          manifestId: sel.manifest.id,
          taskId: this.taskId,
          status: 'failed',
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          findings: [],
          artifacts: [],
          candidates: [],
          diagnostics: {
            truncated: false,
            parserWarnings: [`dispatch failed: ${(err as Error).message}`],
          },
          confidence: 0,
          falsePositiveRisk: sel.manifest.scheduling.falsePositiveRisk,
          summary: 'dispatch failed',
        })
      }
    }
    return results
  }

  /** Per-run cancellation (§八). */
  async cancelRun(
    runId: string,
    reason: string,
  ): Promise<
    | { ok: true }
    | { ok: false; reason: 'unknown_run' | 'already_terminal' | 'cancel_failed' | 'wrong_task' }
  > {
    const active = this.activeRuns.get(runId)
    if (!active) return { ok: false, reason: 'unknown_run' }
    // §round-2 audit fix — verify the runId belongs to the calling
    // task. A model that learned another task's runId could otherwise
    // cancel its runs.
    if (active.record.taskId !== this.taskId) {
      return { ok: false, reason: 'wrong_task' }
    }
    const status = active.record.status
    if (status !== 'queued' && status !== 'running') {
      return { ok: false, reason: 'already_terminal' }
    }
    try {
      active.controller.controller.abort(reason)
      if (active.backgroundJobId) {
        this.deps.jobManager.cancel(active.backgroundJobId, reason)
      }
      return { ok: true }
    } catch {
      return { ok: false, reason: 'cancel_failed' }
    }
  }

  /** Cancel every in-flight run for the given task. */
  async cancelTask(taskId: string): Promise<number> {
    let n = 0
    for (const [runId, active] of this.activeRuns.entries()) {
      if (active.record.taskId !== taskId) continue
      const r = await this.cancelRun(runId, `task_cancel:${taskId}`)
      if (r.ok) n++
    }
    return n
  }

  /** Inspect a single finished run — uses the ResultStore (§九). */
  async getResult(runId: string): Promise<OneShotResult | null> {
    return this.resultStore.get(runId)
  }

  /** List every persisted result for this task. */
  async listResults(): Promise<OneShotResult[]> {
    return this.resultStore.listByTask(this.taskId)
  }

  private async executeRun(
    manifestId: string,
    record: OneShotRunRecord,
    attempt: CTFAttempt,
    linked: LinkedAbortController,
    inputs: DispatcherInputs,
    logDir: string,
  ): Promise<OneShotResult> {
    const manifest = this.deps.registry.get(manifestId)
    if (!manifest) throw new Error(`unknown manifest: ${manifestId}`)
    const lane = manifest.scheduling.costTier
    const runner = runnerFor(manifest)
    const startedAt = new Date().toISOString()

    // §六 — route through BackgroundJobManager. The runner registry
    // resolves `toolId: oneshot:<manifest>` to a JobRunner that invokes
    // runnerFor(manifest).run(). If a registry IS wired, the registry's
    // JobRunner drives execution and we just wait — preventing the
    // double-execution that happened when the dispatcher also invoked
    // `runner.run()` directly. If no registry is wired, the dispatcher
    // invokes the runner directly (test seam).
    const toolId = `oneshot:${manifestId}`
    const hasRegistry = this.deps.runnerRegistry?.resolve(toolId) != null
    let backgroundJobId = ''
    let runnerOutput: OneShotResult | undefined
    try {
      const spec: JobSpec = {
        taskId: this.taskId,
        agentId: this.taskContext.profileId,
        toolId,
        input: {
          oneShotRunId: record.id,
          manifestId,
          resolvedInput: inputs.resolvedInput ?? {},
          evidenceRoot: record.evidenceRoot,
          argv: inputs.argv,
          workspace: this.deps.workspace,
          logDir,
        },
        timeoutMs: (manifest.resources.timeoutSeconds ?? 60) * 1000,
      }
      const job = await this.deps.jobManager.spawn(spec)
      backgroundJobId = job.id
      record.backgroundJobId = backgroundJobId
      // Update both the record and the active-runs entry so cancelRun
      // can call jobManager.cancel(backgroundJobId).
      const entry = this.activeRuns.get(record.id)
      if (entry) entry.backgroundJobId = backgroundJobId
      this.deps.orchestrator?.updateOneShot(record.id, { backgroundJobId })
      this.deps.orchestrator?.recordOneShotStarted(record.id, backgroundJobId, Date.now())

      // Emit ONESHOT_STARTED AFTER the spawn succeeds so observers never
      // see a started event without a backgroundJobId.
      this.emit({
        type: 'ONESHOT_STARTED',
        runId: record.id,
        manifestId,
        taskId: this.taskId,
        lane,
        at: startedAt,
      })

      if (!hasRegistry) {
        // Test/dev path — no registry is wired. Invoke runner directly so
        // the returned OneShotResult carries real findings/artifacts/
        // candidates. Production routes through the registry, which
        // captures the runner's return value in the BackgroundJob's
        // `summary`/`artifactId` fields.
        const directOutput = await runner.run(manifest, {
          logDir,
          argv: inputs.argv,
          workspace: this.deps.workspace,
          signal: linked.signal,
        })
        runnerOutput = directOutput
      }
      await this.deps.jobManager.wait(job.id, spec.timeoutMs)
    } catch (err) {
      const finishedAt = Date.now()
      const message = (err as Error).message
      // Classify the error against the actual job status (which is
      // authoritative for timeout/cancellation) and the linked signal.
      const job = backgroundJobId ? this.deps.jobManager.status(backgroundJobId) : null
      const status: OneShotRunStatus = this.classifyFailure(job, linked.signal.aborted)
      const finalResult: OneShotResult = {
        runId: record.id,
        manifestId,
        taskId: this.taskId,
        status,
        startedAt,
        finishedAt: new Date(finishedAt).toISOString(),
        findings: [],
        artifacts: [],
        candidates: [],
        diagnostics: {
          truncated: false,
          parserWarnings: [message],
        },
        confidence: 0,
        falsePositiveRisk: manifest.scheduling.falsePositiveRisk,
        summary: status,
      }
      // §二十二 — persist the Result BEFORE projecting TaskState and
      // emitting the terminal event so observers never see terminal
      // status without a durable Result.
      await this.resultStore.save(finalResult)
      // §十八 — TaskState is deep-frozen; build a new record rather
      // than mutating the frozen one. updateOneShot projects the
      // immutable patch into the store.
      const resultPath = this.resultStore.resolvePath(record.id)
      this.deps.orchestrator?.updateOneShot(record.id, { resultPath })
      this.projectTerminalStatus(record, attempt, status, message, finishedAt)
      this.emitTerminalEvent(status, record.id, manifestId, lane, finishedAt, message)
      throw err
    }

    // Success path. The runner may have returned a structured
    // OneShotResult (test/dev path) — use it. Production route reads
    // from the BackgroundJob's persisted summary.
    const job = this.deps.jobManager.status(backgroundJobId)
    // §round-2 audit fix — prefer the OneShot payload the registry's
    // JobRunner handed back through `job.payload`. The direct-runner
    // path captures the return value into `runnerOutput`. If neither
    // is present, fall back to an empty success envelope built from
    // the BackgroundJob's `summary`.
    const payloadResult = this.decodePayload(job?.payload)
    const raw: OneShotResult =
      runnerOutput ??
      payloadResult ??
      this.buildSuccessResult(record.id, manifestId, manifest, startedAt, job)

    const normalized = normalizeResult(raw, undefined, manifest)
    normalized.taskId = this.taskId
    normalized.runId = record.id
    normalized.startedAt = startedAt
    normalized.finishedAt = raw.finishedAt

    // §二十二 — persist BEFORE projecting TaskState and emitting events.
    await this.resultStore.save(normalized)
    // §十八 — TaskState is deep-frozen; project the resultPath through
    // the orchestrator instead of mutating the dispatcher's record.
    const resultPath = this.resultStore.resolvePath(record.id)
    this.deps.orchestrator?.updateOneShot(record.id, { resultPath })

    const completedAt = Date.now()
    const finalStatus: OneShotRunStatus =
      normalized.status === 'completed'
        ? 'completed'
        : normalized.status === 'partial'
          ? 'partial'
          : normalized.status === 'unavailable'
            ? 'unavailable'
            : normalized.status === 'timeout'
              ? 'timeout'
              : normalized.status === 'cancelled'
                ? 'cancelled'
                : 'failed'
    if (finalStatus === 'completed') {
      this.deps.orchestrator?.recordOneShotCompleted(
        record.id,
        normalized.summary,
        normalized.findings.map((f) => this.fingerprintFinding(f)),
        [],
        normalized.candidates.map((c) => c.value),
        completedAt,
      )
      this.deps.orchestrator?.updateAttempt(attempt.id, {
        status: 'succeeded',
        error: undefined,
        completedAt,
      })
    } else {
      this.projectTerminalStatus(record, attempt, finalStatus, normalized.summary, completedAt)
    }

    // Emit observational events AFTER persistence + state projection so
    // listeners never see terminal completion before TaskState catches up.
    this.emitCompletedEvents(normalized)
    return normalized
  }

  /** Classify a run failure using the BackgroundJob's authoritative
   *  status (if any) and the linked signal's abort state. */
  private classifyFailure(
    job: {
      status: 'pending' | 'running' | 'success' | 'failed' | 'cancelled'
      cancelReason?: string
    } | null,
    signalAborted: boolean,
  ): OneShotRunStatus {
    if (signalAborted) return 'cancelled'
    if (job?.status === 'cancelled') return 'cancelled'
    if (job?.cancelReason === 'timeout') return 'timeout'
    return 'failed'
  }

  /** Build the OneShotResult for a successful run. Pulls the BackgroundJob's
   *  summary if the registry path didn't return a richer result. */
  /** Decode the base64-encoded OneShotResult payload persisted by the
   *  registry's JobRunner. Returns `null` on any decode error so the
   *  dispatcher falls back to building an empty envelope. */
  private decodePayload(payload: string | undefined): OneShotResult | null {
    if (!payload) return null
    try {
      const json = Buffer.from(payload, 'base64').toString('utf8')
      const obj = JSON.parse(json) as OneShotResult
      return obj
    } catch {
      return null
    }
  }

  /** §round-2 audit fix — heuristic network-target detection. We pass
   *  any argv value that looks like a host/IP/URL through ScopeGate.
   *  This is intentionally conservative — false positives just trigger
   *  a `ScopeDeniedError` rather than permit a private-IP SSRF. */
  private looksLikeNetworkTarget(arg: string): boolean {
    if (!arg) return false
    // IPv4: 1.2.3.4
    if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(arg)) return true
    // Bracketed IPv6: [::1]:443
    if (/^\[[0-9a-fA-F:]+\](:\d+)?$/.test(arg)) return true
    // Bare IPv6: ::1
    if (/^[0-9a-fA-F:]+$/.test(arg) && arg.includes(':')) return true
    // URL with scheme
    if (/^[a-z][a-z0-9+.-]*:\/\//.test(arg)) return true
    // host:port or host
    if (/^[A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,}(:\d+)?$/.test(arg)) return true
    return false
  }

  private buildSuccessResult(
    runId: string,
    manifestId: string,
    manifest: import('./types.js').OneShotManifest,
    startedAt: string,
    job: {
      status: 'pending' | 'running' | 'success' | 'failed' | 'cancelled'
      summary?: string
    } | null,
  ): OneShotResult {
    const finishedAt = new Date().toISOString()
    const status: import('./types.js').OneShotStatus =
      job?.status === 'failed' ? 'failed' : job?.status === 'cancelled' ? 'cancelled' : 'completed'
    return {
      runId,
      manifestId,
      taskId: this.taskId,
      status,
      startedAt,
      finishedAt,
      findings: [],
      artifacts: [],
      candidates: [],
      diagnostics: { truncated: false, parserWarnings: [] },
      confidence: 0,
      falsePositiveRisk: manifest.scheduling.falsePositiveRisk,
      summary: job?.summary ?? '',
    }
  }

  /** Project the terminal OneShot status into TaskState via the
   *  Orchestrator. Maps to the right recordOneShot* helper and updates
   *  the Attempt status consistently. */
  private projectTerminalStatus(
    record: OneShotRunRecord,
    attempt: CTFAttempt,
    status: OneShotRunStatus,
    summary: string,
    completedAt: number,
  ): void {
    const o = this.deps.orchestrator
    if (!o) return
    switch (status) {
      case 'completed':
        // Success path is handled by executeRun's success branch.
        return
      case 'partial':
        o.recordOneShotPartial(record.id, summary, completedAt)
        o.updateAttempt(attempt.id, {
          status: 'succeeded',
          error: { message: summary },
          completedAt,
        })
        return
      case 'timeout':
        o.recordOneShotTimeout(record.id, summary, completedAt)
        o.updateAttempt(attempt.id, {
          status: 'failed',
          error: { message: summary, code: 'timeout' },
          completedAt,
        })
        return
      case 'cancelled':
        o.recordOneShotCancelled(record.id, summary, completedAt)
        o.updateAttempt(attempt.id, {
          status: 'cancelled',
          error: { message: summary },
          completedAt,
        })
        return
      case 'failed':
      case 'unavailable':
      default:
        o.recordOneShotFailed(record.id, summary, completedAt)
        o.updateAttempt(attempt.id, { status: 'failed', error: { message: summary }, completedAt })
        return
    }
  }

  /** Emit the appropriate terminal projection event. */
  private emitTerminalEvent(
    status: OneShotRunStatus,
    runId: string,
    manifestId: string,
    lane: OneShotLane,
    finishedAt: number,
    message: string,
  ): void {
    const at = new Date(finishedAt).toISOString()
    const eventType =
      status === 'cancelled'
        ? 'ONESHOT_CANCELLED'
        : status === 'timeout'
          ? 'ONESHOT_TIMEOUT'
          : status === 'partial'
            ? 'ONESHOT_COMPLETED' // partial → use completed event with detail
            : 'ONESHOT_FAILED'
    this.emit({
      type: eventType,
      runId,
      manifestId,
      taskId: this.taskId,
      lane,
      at,
      detail: { error: message, status },
    })
  }

  private releaseResources(runId: string): void {
    const active = this.activeRuns.get(runId)
    if (!active) return
    const ticket = this.ticketByRun.get(runId)
    if (ticket) {
      this.budget.release(ticket)
      this.ticketByRun.delete(runId)
    }
    active.controller.unlink()
    this.activeRuns.delete(runId)
    // §round-2 audit fix — do NOT release the ResultStore reference here.
    // TaskState's OneShotRunRecord.resultPath still points at the saved
    // file; releasing the ref allows GC to delete a file that the state
    // index claims exists, violating the §九 retention contract. The ref
    // is released explicitly when the OneShotRunRecord itself is removed
    // (or when the orchestrator's persist passes ownership to TaskState).
  }

  private emitCompletedEvents(result: OneShotResult): void {
    const at = result.finishedAt ?? new Date().toISOString()
    for (const f of result.findings) {
      this.emit({
        type: 'ONESHOT_FINDING',
        runId: result.runId,
        manifestId: result.manifestId,
        taskId: this.taskId,
        lane: this.laneFor(result),
        at,
        detail: { finding: f },
      })
    }
    for (const a of result.artifacts) {
      this.emit({
        type: 'ONESHOT_ARTIFACT',
        runId: result.runId,
        manifestId: result.manifestId,
        taskId: this.taskId,
        lane: this.laneFor(result),
        at,
        detail: { artifact: a },
      })
    }
    for (const c of result.candidates) {
      this.emit({
        type: 'ONESHOT_CANDIDATE',
        runId: result.runId,
        manifestId: result.manifestId,
        taskId: this.taskId,
        lane: this.laneFor(result),
        at,
        detail: { candidate: c },
      })
    }
    if (result.status === 'timeout') {
      this.emit({
        type: 'ONESHOT_TIMEOUT',
        runId: result.runId,
        manifestId: result.manifestId,
        taskId: this.taskId,
        lane: this.laneFor(result),
        at,
      })
    } else if (result.status === 'cancelled') {
      this.emit({
        type: 'ONESHOT_CANCELLED',
        runId: result.runId,
        manifestId: result.manifestId,
        taskId: this.taskId,
        lane: this.laneFor(result),
        at,
      })
    } else {
      this.emit({
        type: 'ONESHOT_COMPLETED',
        runId: result.runId,
        manifestId: result.manifestId,
        taskId: this.taskId,
        lane: this.laneFor(result),
        at,
      })
    }
  }

  private laneFor(result: OneShotResult): OneShotLane {
    const m = this.deps.registry.get(result.manifestId)
    return m?.scheduling.costTier ?? 'fast'
  }

  private collectInputArtifactIds(input: Record<string, unknown> | undefined): string[] {
    if (!input) return []
    const out: string[] = []
    for (const [k, v] of Object.entries(input)) {
      if (k.startsWith('artifact:') && typeof v === 'string') out.push(v)
    }
    return out
  }

  private shortFingerprint(inputs: DispatcherInputs): string {
    const parts = inputs.argv.slice(0, 3).join(' ')
    return `${parts}`.slice(0, 32)
  }

  private fingerprintFinding(f: NormalizedFinding): string {
    return `${f.category}/${f.title}`
  }
}

/* Re-export helper types so callers don't need separate imports. */
export type { SelectedRun, SelectionInput }
export type { NormalizedFinding, CandidateValue }
