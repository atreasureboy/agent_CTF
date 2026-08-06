import { CTFTaskStateStore } from './taskStateStore.js'
import type { CTFTaskState } from './taskState.js'
import type { TaskExecutionContext } from './taskExecutionContext.js'

export interface QueuedChallenge {
  id: string
  title: string
  category: string
  description?: string
  flagPattern?: string
  inputArtifactPaths?: string[]
  priority?: number
}

export type ChallengeTaskStatus = 'queued' | 'running' | 'solved' | 'failed' | 'paused'

export interface ChallengeTaskHandle {
  challenge: QueuedChallenge
  store: CTFTaskStateStore
  status: ChallengeTaskStatus
  startedAt?: number
  endedAt?: number
  foundFlag?: string
}

/**
 * §Round-7 — `TaskExecutor` is the seam between the pool's queue
 * management and the actual solver. The previous version of
 * `spawnNext()` only built state stores and returned handles — the
 * orchestrator / specialist / solver was never started. This
 * callback lets callers plug in the real Agent runtime:
 *
 *   const pool = new ChallengeConcurrencyPool(4, {
 *     executor: async (ch, handle, signal) => {
 *       const runtime = await createCTFTaskRuntime({...})
 *       const result = await runtime.orchestrator.runMainAgent(ch.description, ...)
 *       return { status: result.foundFlag ? 'solved' : 'failed', flag: result.foundFlag }
 *       // Pool auto-applies markCompleted on return.
 *     },
 *   })
 */
export type TaskExecutorResult = { status: 'solved' | 'failed'; flag?: string }
export type TaskExecutor = (
  challenge: QueuedChallenge,
  handle: ChallengeTaskHandle,
  signal: AbortSignal,
) => Promise<TaskExecutorResult>

export interface ChallengeConcurrencyPoolOptions {
  /**
   * Real solver — if omitted the pool still functions as a queue
   * (handles are returned, state stores are populated) but no work
   * is actually started. This is useful for callers that want to
   * batch-spawn without auto-execution.
   */
  executor?: TaskExecutor
  /**
   * Hook called after each completion, BEFORE auto-queue-filling
   * runs. Lets callers update external metrics. The default is a
   * no-op.
   */
  onCompleted?: (handle: ChallengeTaskHandle) => void
}

export class ChallengeConcurrencyPool {
  private readonly maxConcurrency: number
  private queue: QueuedChallenge[] = []
  private activeHandles = new Map<string, ChallengeTaskHandle>()
  private completedHandles = new Map<string, ChallengeTaskHandle>()
  private readonly executor?: TaskExecutor
  private readonly onCompleted?: (handle: ChallengeTaskHandle) => void
  private readonly abortController = new AbortController()
  private inFlight = new Set<Promise<void>>()
  /** When `cancelAll()` has fired, the pool is dead — no further
   *  tasks will run and `addChallenge` is a no-op. */
  private cancelled = false
  private cancelReason: string | null = null

  constructor(maxConcurrency: number, options: ChallengeConcurrencyPoolOptions = {}) {
    if (!Number.isInteger(maxConcurrency) || maxConcurrency <= 0) {
      throw new Error(
        `ChallengeConcurrencyPool: maxConcurrency must be a positive integer, got ${maxConcurrency}`,
      )
    }
    this.maxConcurrency = maxConcurrency
    this.executor = options.executor
    this.onCompleted = options.onCompleted
  }

  /**
   * Enqueue a new challenge. Duplicate IDs (already running or
   * completed) are silently ignored — the pool keeps a single
   * authoritative record per id.
   */
  public addChallenge(challenge: QueuedChallenge): void {
    if (this.cancelled) return
    if (this.activeHandles.has(challenge.id) || this.completedHandles.has(challenge.id)) {
      return
    }
    if (this.queue.some((c) => c.id === challenge.id)) {
      return
    }
    this.queue.push(challenge)
    this.queue.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
  }

  public addChallenges(challenges: QueuedChallenge[]): void {
    for (const ch of challenges) {
      this.addChallenge(ch)
    }
  }

  /**
   * Cancel every running + queued task. Subsequent `addChallenge`
   * calls are no-ops; `spawnNext` returns `[]`. The pool cannot be
   * reused after this call (mirrors the existing destroy-on-cancel
   * pattern in the rest of the runtime).
   *
   * Returns the cancel reason for observability.
   */
  public cancelAll(reason: string): string {
    this.cancelled = true
    this.cancelReason = reason
    this.abortController.abort()
    // Mark active as failed so test asserts see them as terminated.
    for (const h of this.activeHandles.values()) {
      h.status = 'failed'
      h.endedAt = Date.now()
      this.completedHandles.set(h.challenge.id, h)
    }
    this.activeHandles.clear()
    this.queue.length = 0
    return reason
  }

  /** Read the cancel reason (null if not cancelled). */
  public getCancelReason(): string | null {
    return this.cancelReason
  }

  public getAvailableSlots(): number {
    return Math.max(0, this.maxConcurrency - this.activeHandles.size)
  }

  /**
   * Promote queued → running up to maxConcurrency. Returns the
   * newly-spawned handles.
   *
   * §Round-7 — fires the `executor` for each newly-spawned handle
   * (if one was provided) and tracks it in `inFlight` so callers
   * can await settlement via `waitForAll()`.
   *
   * §Round-8 — auto-fills the queue: when an executor returns,
   * `markCompleted` is called automatically AND `spawnNext()` is
   * re-invoked so a finished slot immediately picks up the next
   * queued challenge. Combined with `waitForAll`, callers can just
   * `addChallenges(...)` then `waitForAll()` and the whole queue
   * drains.
   */
  public spawnNext(): ChallengeTaskHandle[] {
    if (this.cancelled) return []
    const spawned: ChallengeTaskHandle[] = []
    while (this.getAvailableSlots() > 0 && this.queue.length > 0) {
      const challenge = this.queue.shift()!
      // Defensive: in case addChallenge's queue-uniqueness check is
      // bypassed by concurrent callers, drop any duplicate.
      if (this.activeHandles.has(challenge.id)) continue
      const initial: CTFTaskState = makeInitialState(challenge)
      const store = new CTFTaskStateStore(initial)
      const handle: ChallengeTaskHandle = {
        challenge,
        store,
        status: 'running',
        startedAt: Date.now(),
      }

      this.activeHandles.set(challenge.id, handle)
      spawned.push(handle)

      if (this.executor) {
        const signal = this.abortController.signal
        const task: Promise<void> = this.executor(challenge, handle, signal)
          .then((result) => {
            // §Round-8 — Pool auto-marks completion based on the
            // executor's return value. Callers no longer need to
            // remember to call `pool.markCompleted` themselves.
            this.applyExecutorResult(challenge.id, result)
          })
          .catch((err: unknown) => {
            handle.status = 'failed'
            handle.endedAt = Date.now()
            this.completedHandles.set(handle.challenge.id, handle)
            this.activeHandles.delete(handle.challenge.id)
            // eslint-disable-next-line no-console
            console.error(
              `[concurrency-pool] executor for ${challenge.id} failed:`,
              (err as Error)?.message ?? String(err),
            )
          })
          .finally(() => {
            this.inFlight.delete(task)
            // §Round-8 — auto-fill. Spawn more so the queue keeps
            // draining until empty or maxConcurrency hit.
            if (!this.cancelled) this.spawnNext()
          })
        this.inFlight.add(task)
      }
    }
    return spawned
  }

  /**
   * Await every in-flight executor AND every queued challenge.
   * Combined with `addChallenges(...)`, callers can express the
   * canonical "submit N tasks, wait until they're all done" loop
   * in two lines.
   */
  public async waitForAll(): Promise<void> {
    // Keep spinning while there's queue OR active work.
    while (this.inFlight.size > 0 || this.queue.length > 0) {
      // Trigger fills if nothing in flight (avoids deadlock if a
      // caller forgot to call spawnNext).
      if (this.inFlight.size === 0 && this.queue.length > 0) {
        this.spawnNext()
      }
      await Promise.allSettled([...this.inFlight])
    }
  }

  /**
   * Mark a challenge task as completed. Public so executors that
   * want to surface intermediate progress (e.g. emit a finding
   * before the executor resolves) can call this directly.
   *
   * @internal The auto-fill trigger fires here too.
   */
  public markCompleted(challengeId: string, status: 'solved' | 'failed', foundFlag?: string): void {
    const handle = this.activeHandles.get(challengeId)
    if (!handle) return
    this.applyExecutorResult(challengeId, { status, flag: foundFlag })
  }

  private applyExecutorResult(challengeId: string, result: TaskExecutorResult): void {
    const handle = this.activeHandles.get(challengeId)
    if (!handle) return
    handle.status = result.status
    handle.endedAt = Date.now()
    if (result.flag) {
      handle.foundFlag = result.flag
    }
    this.completedHandles.set(challengeId, handle)
    this.activeHandles.delete(challengeId)
    if (this.onCompleted) this.onCompleted(handle)
  }

  public getStats(): { queued: number; running: number; completed: number; solved: number } {
    let solved = 0
    for (const h of this.completedHandles.values()) {
      if (h.status === 'solved') solved++
    }
    return {
      queued: this.queue.length,
      running: this.activeHandles.size,
      completed: this.completedHandles.size,
      solved,
    }
  }

  public isCancelled(): boolean {
    return this.cancelled
  }

  /** Get all completed handles for result collection. */
  public getCompletedHandles(): ChallengeTaskHandle[] {
    return [...this.completedHandles.values()]
  }

  public getMaxConcurrency(): number {
    return this.maxConcurrency
  }
}

function makeInitialState(challenge: QueuedChallenge): CTFTaskState {
  return {
    taskId: challenge.id,
    phase: 'created',
    activeProfileId: challenge.category.toLowerCase() || 'default',
    context: { taskId: challenge.id } as unknown as TaskExecutionContext,
    challenge: {
      description: challenge.description,
      category: challenge.category,
      flagPattern: challenge.flagPattern,
      inputArtifactIds: challenge.inputArtifactPaths ?? [],
    },
    findings: [],
    artifactIds: [],
    hypotheses: [],
    attempts: [],
    handoffs: [],
    agentRuns: [],
    workflowRuns: [],
    jobs: [],
    solverRuns: [],
    oneShotRuns: [],
    observations: [],
    evidence: [],
    strategyDecisions: [],
    pendingActions: [],
    reasoningBudget: {} as unknown as CTFTaskState['reasoningBudget'],
    reasoningBudgetLimits: {} as unknown as CTFTaskState['reasoningBudgetLimits'],
    activeAgentRunIds: [],
    activeWorkflowRunIds: [],
    activeJobIds: [],
    activeSolverRunIds: [],
    flagCandidates: [],
    diagnostics: [],
    degraded: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}
