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
 *     executor: async (ch, handle) => {
 *       const runtime = await createCTFTaskRuntime({...})
 *       const result = await runtime.orchestrator.runMainAgent(ch.description)
 *       pool.markCompleted(ch.id, result.foundFlag ? 'solved' : 'failed', result.foundFlag)
 *     },
 *   })
 */
export type TaskExecutor = (
  challenge: QueuedChallenge,
  handle: ChallengeTaskHandle,
  signal: AbortSignal,
) => Promise<{ status: 'solved' | 'failed'; flag?: string }>

export interface ChallengeConcurrencyPoolOptions {
  /** Real solver — required to actually start work; if omitted the
   *  pool still functions as a queue but `spawnNext()` won't progress. */
  executor?: TaskExecutor
}

export class ChallengeConcurrencyPool {
  private maxConcurrency: number
  private queue: QueuedChallenge[] = []
  private activeHandles = new Map<string, ChallengeTaskHandle>()
  private completedHandles = new Map<string, ChallengeTaskHandle>()
  private readonly executor?: TaskExecutor
  private readonly abortController = new AbortController()
  private inFlight = new Set<Promise<void>>()

  constructor(maxConcurrency = 5, options: ChallengeConcurrencyPoolOptions = {}) {
    this.maxConcurrency = maxConcurrency
    this.executor = options.executor
  }

  /**
   * Enqueue a new challenge into the pool.
   */
  public addChallenge(challenge: QueuedChallenge): void {
    if (this.activeHandles.has(challenge.id) || this.completedHandles.has(challenge.id)) {
      return
    }
    this.queue.push(challenge)
    // Sort by priority (higher priority first)
    this.queue.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
  }

  /**
   * Batch enqueue multiple challenges into the pool.
   */
  public addChallenges(challenges: QueuedChallenge[]): void {
    for (const ch of challenges) {
      this.addChallenge(ch)
    }
  }

  /**
   * Cancel every running + queued task. The executor sees the abort
   * signal and should unwind promptly (typical: orchestrator.cancel()).
   */
  public cancelAll(reason: string): void {
    this.abortController.abort()
    // Mark all active handles as failed (best-effort; real cleanup is
    // the executor's responsibility via the signal).
    for (const h of this.activeHandles.values()) {
      h.status = 'failed'
      h.endedAt = Date.now()
      this.completedHandles.set(h.challenge.id, h)
    }
    this.activeHandles.clear()
    this.queue.length = 0
  }

  /**
   * Get active concurrency slot count available.
   */
  public getAvailableSlots(): number {
    return Math.max(0, this.maxConcurrency - this.activeHandles.size)
  }

  /**
   * Spawn next available challenges up to maxConcurrency limit.
   *
   * §Round-7 — previously this method only built state stores and
   * returned handles. Real solver work never started. Now: if a
   * `TaskExecutor` was provided at construction, fire it for each
   * newly-spawned handle in the background. The executor is awaited
   * via the in-flight set; when it resolves, it should call
   * `markCompleted()` itself (the pool doesn't infer flag discovery
   * from the executor's return value, since some executors will
   * complete via side-effects on the store).
   *
   * Returns the list of handles that were promoted from queued to
   * running in this call.
   */
  public spawnNext(): ChallengeTaskHandle[] {
    const spawned: ChallengeTaskHandle[] = []
    while (this.getAvailableSlots() > 0 && this.queue.length > 0) {
      const challenge = this.queue.shift()!
      const initial: CTFTaskState = {
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

      const store = new CTFTaskStateStore(initial)
      const handle: ChallengeTaskHandle = {
        challenge,
        store,
        status: 'running',
        startedAt: Date.now(),
      }

      this.activeHandles.set(challenge.id, handle)
      spawned.push(handle)

      // Fire the executor if provided. We track the in-flight
      // promise so callers can await full settlement via
      // `waitForAll()`. The executor's own contract is to call
      // `pool.markCompleted(id, ...)` once the solve finishes.
      if (this.executor) {
        const signal = this.abortController.signal
        const task: Promise<void> = this.executor(challenge, handle, signal)
          .then(() => undefined)
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
          })
        this.inFlight.add(task)
      }
    }
    return spawned
  }

  /**
   * Await every in-flight executor. Useful for tests / shutdown.
   */
  public async waitForAll(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight])
    }
  }

  /**
   * Mark a challenge task as completed (solved or failed).
   */
  public markCompleted(challengeId: string, status: 'solved' | 'failed', foundFlag?: string): void {
    const handle = this.activeHandles.get(challengeId)
    if (!handle) return

    handle.status = status
    handle.endedAt = Date.now()
    if (foundFlag) {
      handle.foundFlag = foundFlag
    }

    this.activeHandles.delete(challengeId)
    this.completedHandles.set(challengeId, handle)
  }

  /**
   * Get pool statistics (queued, running, completed, solved count).
   */
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
}
