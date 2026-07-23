/**
 * BackgroundJobManager — single source of truth for long-running tool /
 * workflow invocations that should not block the model's reasoning.
 *
 * Responsibilities:
 *   - Spawn a job with optional concurrency-bounded queueing.
 *   - Track lifecycle (pending → running → success / failed / cancelled)
 *     in-memory + persisted to `<taskWorkspace>/jobs/<id>.json`.
 *   - Provide wait/cancel/collect/list semantics to the Orchestrator.
 *   - Drive the execution via a registered runner (ToolBroker or
 *     WorkflowEngine) that the constructor takes as a dependency.
 *
 * Concurrency policy:
 *   - maxPerAgent (default 4) — jobs run by the same agent concurrently.
 *   - maxPerTask  (default 16) — jobs across the whole task concurrently.
 *
 * The Broker queries the manager to decide if a tool call should run inline or
 * be spawned. Cancelled jobs are NEVER resurrected — they return 'cancelled'.
 */

import { randomBytes } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync, renameSync } from 'fs'
import { dirname, join } from 'path'

export type JobStatus = 'pending' | 'running' | 'success' | 'failed' | 'cancelled'

export interface JobSpec {
  taskId: string
  agentId: string
  toolId: string
  input: Record<string, unknown>
  timeoutMs?: number
  /** Optional inline-threshold override for Artifact conversion. */
  inlineMaxBytes?: number
}

export interface BackgroundJob {
  id: string
  taskId: string
  agentId: string
  toolId: string
  inputSummary: string
  status: JobStatus
  startedAt: string
  endedAt?: string
  timeoutMs: number
  artifactId?: string
  summary?: string
  error?: string
  cancelReason?: string
}

export type JobRunner = (spec: JobSpec, signal: AbortSignal) => Promise<{
  summary?: string
  artifactId?: string
  error?: string
}>

/**
 * Optional runner registry — lets callers route `toolId: prefix:*` jobs to
 * different runners. When set, `execute` resolves the runner by toolId
 * prefix; otherwise it falls back to the single `runner` from the
 * constructor.
 */
export interface JobRunnerRegistry {
  register(prefix: string, runner: JobRunner): void
  resolve(toolId: string): JobRunner | null
}

export class JobRunnerRegistryImpl implements JobRunnerRegistry {
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

/** Lifecycle events emitted by `BackgroundJobManager`. Listeners receive
 *  every transition; the orchestrator mirrors them into CTFTaskState.jobs.
 *  No polling, no monkey-patching of methods — just an EventEmitter-style
 *  subscribe. */
export type BackgroundJobEvent =
  | { type: 'JOB_STARTED'; job: BackgroundJob }
  | { type: 'JOB_UPDATED'; job: BackgroundJob }
  | { type: 'JOB_COMPLETED'; job: BackgroundJob }
  | { type: 'JOB_FAILED'; job: BackgroundJob }
  | { type: 'JOB_CANCELLED'; job: BackgroundJob }

export type JobEventListener = (event: BackgroundJobEvent) => void
export type JobUnsubscribe = () => void

export interface BackgroundJobManagerOptions {
  taskWorkspaceDir: string
  maxPerAgent?: number
  maxPerTask?: number
  /** Defaults to 4. */
  globalTimeoutMs?: number
  /** Optional prefix-based runner registry. When set, jobs with toolIds
   *  matching a registered prefix are routed to that runner instead of
   *  the default constructor runner. */
  runnerRegistry?: JobRunnerRegistry
}

/**
 * In-memory index plus on-disk index.jsonl per task workspace.
 */
export class BackgroundJobManager {
  private readonly jobs = new Map<string, BackgroundJob>()
  private readonly abortControllers = new Map<string, AbortController>()
  private readonly pendingWaiters = new Map<string, Array<() => void>>()
  private readonly taskIndexPaths = new Map<string, string>()
  private readonly taskDirs = new Map<string, string>()
  private readonly listeners = new Set<JobEventListener>()
  private readonly maxPerAgent: number
  private readonly maxPerTask: number
  private readonly globalTimeoutMs: number

  constructor(
    private opts: BackgroundJobManagerOptions,
    private readonly runner: JobRunner,
  ) {
    this.maxPerAgent = opts.maxPerAgent ?? 4
    this.maxPerTask = opts.maxPerTask ?? 16
    this.globalTimeoutMs = opts.globalTimeoutMs ?? 3_600_000  // 1h
    mkdirSync(opts.taskWorkspaceDir, { recursive: true })
  }

  /** Resolve the runner for a given toolId. Prefers the prefix registry;
   *  falls back to the default constructor runner. */
  private resolveRunner(toolId: string): JobRunner {
    const fromRegistry = this.opts.runnerRegistry?.resolve(toolId) ?? null
    return fromRegistry ?? this.runner
  }

  /** Attach a runner registry post-construction. Useful when the catalog
   *  is built after the jobManager (e.g. Phase 2.0 §六 — the OneShot
   *  registry is wired up after the harness is built). */
  setRunnerRegistry(registry: JobRunnerRegistry): void {
    this.opts.runnerRegistry = registry
  }

  /**
   * Subscribe to job lifecycle events. The listener is invoked synchronously
   * after the manager mutates state — no polling. Returns an unsubscribe.
   *
   * Errors thrown by listeners are swallowed so a buggy listener cannot break
   * the manager.
   */
  subscribe(listener: JobEventListener): JobUnsubscribe {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Internal — broadcast a lifecycle event to every subscriber. */
  private emit(event: BackgroundJobEvent): void {
    for (const l of this.listeners) {
      try {
        l(event)
      } catch {
        /* best-effort — listeners must not break the manager */
      }
    }
  }

  /**
   * Add a task workspace route. Calls without a registered task still work
   * but persist their job files under opts.taskWorkspaceDir/loose/.
   */
  registerTaskWorkspace(taskId: string, taskDir: string): void {
    this.taskDirs.set(taskId, taskDir)
    this.taskIndexPaths.set(taskId, join(taskDir, 'jobs', 'index.jsonl'))
    mkdirSync(join(taskDir, 'jobs'), { recursive: true })
  }

  private persist(job: BackgroundJob): void {
    const dir = this.taskDirs.get(job.taskId) ?? join(this.opts.taskWorkspaceDir, 'loose')
    const file = join(dir, 'jobs', `${job.id}.json`)
    mkdirSync(dirname(file), { recursive: true })
    // Audit P1 #G2 — atomic write via temp + rename so a process crash
    // mid-write does not leave a corrupt jobs/<id>.json (which
    // loadTask's `catch { continue }` silently drops, losing the
    // job's history). renameSync is atomic on POSIX.
    try {
      const tmp = `${file}.tmp.${process.pid}`
      writeFileSync(tmp, JSON.stringify(job, null, 2), 'utf8')
      renameSync(tmp, file)
    } catch {
      writeFileSync(file, JSON.stringify(job, null, 2), 'utf8')
    }
    const indexPath = this.taskIndexPaths.get(job.taskId) ?? join(dir, 'jobs', 'index.jsonl')
    // Append a single-line record to index. Cheap and idempotent on re-read.
    try {
      const line = JSON.stringify({ id: job.id, status: job.status, startedAt: job.startedAt })
      writeFileSync(indexPath, `${line}\n`, { encoding: 'utf8', flag: 'a' })
    } catch { /* best-effort */ }
  }

  private reconcileRunningCount(taskId: string): number {
    let n = 0
    for (const job of this.jobs.values()) {
      if (job.taskId === taskId && (job.status === 'running' || job.status === 'pending')) n++
    }
    return n
  }

  private reconcileAgentCount(agentId: string): number {
    let n = 0
    for (const job of this.jobs.values()) {
      if (job.agentId === agentId && (job.status === 'running' || job.status === 'pending')) n++
    }
    return n
  }

  /** Spawn a new job. Concurrency limits either succeed immediately or
   * throw ConcurrencyLimitError so the Broker can choose to wait or fallback
   * to inline execution. */
  async spawn(spec: JobSpec): Promise<BackgroundJob> {
    const totalForTask = this.reconcileRunningCount(spec.taskId)
    if (totalForTask >= this.maxPerTask) {
      throw new ConcurrencyLimitError(
        `Task ${spec.taskId} reached maxPerTask (${this.maxPerTask})`,
        'task',
      )
    }
    const totalForAgent = this.reconcileAgentCount(spec.agentId)
    if (totalForAgent >= this.maxPerAgent) {
      throw new ConcurrencyLimitError(
        `Agent ${spec.agentId} reached maxPerAgent (${this.maxPerAgent})`,
        'agent',
      )
    }

    const id = `job_${randomBytes(8).toString('hex')}`
    const controller = new AbortController()
    const job: BackgroundJob = {
      id,
      taskId: spec.taskId,
      agentId: spec.agentId,
      toolId: spec.toolId,
      inputSummary: JSON.stringify(spec.input ?? {}).slice(0, 200),
      status: 'pending',
      startedAt: new Date().toISOString(),
      timeoutMs: spec.timeoutMs ?? this.globalTimeoutMs,
    }
    this.jobs.set(id, job)
    this.abortControllers.set(id, controller)
    this.persist(job)
    this.emit({ type: 'JOB_STARTED', job: { ...job } })

    // Fire-and-await execution in next tick so the caller can observe status.
    queueMicrotask(() => this.execute(job, spec, controller.signal))

    return job
  }

  private async execute(job: BackgroundJob, spec: JobSpec, signal: AbortSignal): Promise<void> {
    job.status = 'running'
    this.persist(job)
    this.emit({ type: 'JOB_UPDATED', job: { ...job } })

    // Apply timeout via a side AbortController
    const timeoutCtrl = new AbortController()
    const timer = setTimeout(() => timeoutCtrl.abort('timeout'), job.timeoutMs)
    const combined = AbortSignal.any([signal, timeoutCtrl.signal])

    try {
      const out = await this.runner(spec, combined)
      job.endedAt = new Date().toISOString()
      job.artifactId = out.artifactId
      job.summary = out.summary
      // Precedence: cancelled > failed > success. When the user cancels,
      // the runner may still surface an error message (e.g. "Command
      // cancelled.") so we honour the abort signal as the source of truth.
      if (signal.aborted) {
        job.status = 'cancelled'
        job.cancelReason = (signal.reason as string) ?? 'cancelled'
      } else if (timeoutCtrl.signal.aborted) {
        job.status = 'cancelled'
        job.cancelReason = (timeoutCtrl.signal.reason as string) ?? 'timeout'
      } else if (out.error) {
        job.status = 'failed'
        job.error = out.error
      } else {
        job.status = 'success'
      }
    } catch (err) {
      job.endedAt = new Date().toISOString()
      job.error = (err as Error).message
      if (signal.aborted) {
        job.status = 'cancelled'
        job.cancelReason = signal.reason as string
      } else if (timeoutCtrl.signal.aborted) {
        job.status = 'cancelled'
        job.cancelReason = timeoutCtrl.signal.reason as string
      } else {
        job.status = 'failed'
      }
    } finally {
      clearTimeout(timer)
      this.persist(job)
      // Emit the terminal lifecycle event — orchestrator mirrors these into
      // CTFTaskState.jobs. Subscribers that only care about terminal events
      // can filter on `event.type`.
      if (job.status === 'success') {
        this.emit({ type: 'JOB_COMPLETED', job: { ...job } })
      } else if (job.status === 'failed') {
        this.emit({ type: 'JOB_FAILED', job: { ...job } })
      } else if (job.status === 'cancelled') {
        this.emit({ type: 'JOB_CANCELLED', job: { ...job } })
      }
      const waiters = this.pendingWaiters.get(job.id) ?? []
      this.pendingWaiters.delete(job.id)
      for (const fn of waiters) fn()
    }
  }

  status(id: string): BackgroundJob | null {
    return this.jobs.get(id) ?? null
  }

  list(filter?: (j: BackgroundJob) => boolean): BackgroundJob[] {
    return [...this.jobs.values()].filter((j) => !filter || filter(j))
  }

  /** Wait until the job leaves the running state. Returns the final Job. */
  wait(id: string, timeoutMs: number = 30_000): Promise<BackgroundJob> {
    const job = this.jobs.get(id)
    if (!job) return Promise.resolve(this.status(id) ?? this.recoverFromDisk(id) as BackgroundJob)
    if (job.status !== 'running' && job.status !== 'pending') return Promise.resolve(job)

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Wait timeout for job ${id}`)), timeoutMs)
      const fn = () => {
        clearTimeout(timer)
        const final = this.jobs.get(id)
        if (!final) return reject(new Error(`Job ${id} vanished`))
        resolve(final)
      }
      const arr = this.pendingWaiters.get(id) ?? []
      arr.push(fn)
      this.pendingWaiters.set(id, arr)
    })
  }

  /** Read a job descriptor back from disk (if not in memory). */
  private recoverFromDisk(id: string): BackgroundJob | null {
    // Look up by walking all known task workspaces.
    for (const [taskId, dir] of this.taskDirs) {
      const file = join(dir, 'jobs', `${id}.json`)
      if (existsSync(file)) {
        try {
          const obj = JSON.parse(readFileSync(file, 'utf8')) as BackgroundJob
          this.jobs.set(id, obj)
          return obj
        } catch {
          continue
        }
      }
    }
    return null
  }

  /** Read every job file for a given task from disk — useful after restart. */
  loadTask(taskId: string): BackgroundJob[] {
    const dir = this.taskDirs.get(taskId)
    if (!dir) return []
    const jobsDir = join(dir, 'jobs')
    if (!existsSync(jobsDir)) return []
    const out: BackgroundJob[] = []
    for (const file of readdirSync(jobsDir)) {
      if (!file.endsWith('.json')) continue
      try {
        const obj = JSON.parse(readFileSync(join(jobsDir, file), 'utf8')) as BackgroundJob
        if (obj.taskId === taskId) {
          this.jobs.set(obj.id, obj)
          out.push(obj)
        }
      } catch {
        continue
      }
    }
    return out
  }

  /** Cancel a running job. Returns true if cancellation was issued. */
  cancel(id: string, reason: string = 'user'): boolean {
    const ctrl = this.abortControllers.get(id)
    const job = this.jobs.get(id)
    if (!ctrl || !job) return false
    if (job.status === 'success' || job.status === 'failed' || job.status === 'cancelled') {
      return false
    }
    ctrl.abort(reason)
    job.cancelReason = reason
    job.status = 'cancelled'
    this.persist(job)
    return true
  }

  /** Cancel everything for a task — used when the Orchestrator gives up. */
  cancelTask(taskId: string, reason: string = 'task_cancelled'): number {
    let n = 0
    for (const job of this.jobs.values()) {
      if (job.taskId !== taskId) continue
      if (this.cancel(job.id, reason)) n++
    }
    return n
  }

  /** Garbage-collect finished jobs to keep memory bounded. */
  gc(maxKeep: number = 1000): number {
    const finished = [...this.jobs.entries()]
      .filter(([, j]) => j.status !== 'running' && j.status !== 'pending')
      .sort(([, a], [, b]) => (a.endedAt ?? '').localeCompare(b.endedAt ?? ''))
    const toRemove = finished.slice(0, Math.max(0, finished.length - maxKeep))
    let removed = 0
    for (const [id, job] of toRemove) {
      this.jobs.delete(id)
      this.abortControllers.delete(id)
      const dir = this.taskDirs.get(job.taskId) ?? join(this.opts.taskWorkspaceDir, 'loose')
      const file = join(dir, 'jobs', `${id}.json`)
      if (existsSync(file)) {
        try {
          unlinkSync(file)
          removed++
        } catch { /* best-effort */ }
      }
    }
    return removed
  }
}

export class ConcurrencyLimitError extends Error {
  readonly kind: 'task' | 'agent'
  constructor(message: string, kind: 'task' | 'agent') {
    super(message)
    this.name = 'ConcurrencyLimitError'
    this.kind = kind
  }
}
