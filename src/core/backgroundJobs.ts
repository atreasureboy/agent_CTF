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
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from 'fs'
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

export interface BackgroundJobManagerOptions {
  taskWorkspaceDir: string
  maxPerAgent?: number
  maxPerTask?: number
  /** Defaults to 4. */
  globalTimeoutMs?: number
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
  private readonly maxPerAgent: number
  private readonly maxPerTask: number
  private readonly globalTimeoutMs: number

  constructor(
    private readonly opts: BackgroundJobManagerOptions,
    private readonly runner: JobRunner,
  ) {
    this.maxPerAgent = opts.maxPerAgent ?? 4
    this.maxPerTask = opts.maxPerTask ?? 16
    this.globalTimeoutMs = opts.globalTimeoutMs ?? 3_600_000  // 1h
    mkdirSync(opts.taskWorkspaceDir, { recursive: true })
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
    writeFileSync(file, JSON.stringify(job, null, 2), 'utf8')
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

    // Fire-and-await execution in next tick so the caller can observe status.
    queueMicrotask(() => this.execute(job, spec, controller.signal))

    return job
  }

  private async execute(job: BackgroundJob, spec: JobSpec, signal: AbortSignal): Promise<void> {
    job.status = 'running'
    this.persist(job)

    // Apply timeout via a side AbortController
    const timeoutCtrl = new AbortController()
    const timer = setTimeout(() => timeoutCtrl.abort('timeout'), job.timeoutMs)
    const combined = AbortSignal.any([signal, timeoutCtrl.signal])

    try {
      const out = await this.runner(spec, combined)
      job.endedAt = new Date().toISOString()
      job.artifactId = out.artifactId
      job.summary = out.summary
      if (out.error) {
        job.status = 'failed'
        job.error = out.error
      } else if (signal.aborted || timeoutCtrl.signal.aborted) {
        job.status = 'cancelled'
        job.cancelReason = (signal.reason ?? timeoutCtrl.signal.reason) as string
      } else {
        job.status = 'success'
      }
    } catch (err) {
      job.endedAt = new Date().toISOString()
      job.error = (err as Error).message
      job.status = signal.aborted ? 'cancelled' : 'failed'
      if (signal.aborted) job.cancelReason = signal.reason as string
    } finally {
      clearTimeout(timer)
      this.persist(job)
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
