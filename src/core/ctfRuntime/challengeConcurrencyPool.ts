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

export class ChallengeConcurrencyPool {
  private maxConcurrency: number
  private queue: QueuedChallenge[] = []
  private activeHandles = new Map<string, ChallengeTaskHandle>()
  private completedHandles = new Map<string, ChallengeTaskHandle>()

  constructor(maxConcurrency = 5) {
    this.maxConcurrency = maxConcurrency
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
   * Get active concurrency slot count available.
   */
  public getAvailableSlots(): number {
    return Math.max(0, this.maxConcurrency - this.activeHandles.size)
  }

  /**
   * Spawn next available challenges up to maxConcurrency limit.
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
    }
    return spawned
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
