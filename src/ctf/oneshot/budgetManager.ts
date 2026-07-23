/**
 * BudgetManager — enforces Fast / Medium / Heavy lane concurrency.
 *
 * Defaults from six_goal §八:
 *   - fastConcurrency  = 8
 *   - mediumConcurrency = 3
 *   - heavyConcurrency  = 1
 *   - perTaskMaxRuns    = 12
 *   - perTaskHeavyRuns  = 1
 *
 * Acquisition is fair per-lane and global. The Manager blocks the dispatcher
 * when its lane or the per-task cap is exhausted. A single task can never
 * exceed `perTaskMaxRuns` total runs even if many lanes are free.
 */

import { randomBytes } from 'crypto'
import type { BudgetLimits, OneShotLane } from './types.js'
import { DEFAULT_BUDGET_LIMITS } from './types.js'

export class BudgetExceededError extends Error {
  constructor(message: string, readonly reason: string) {
    super(message)
    this.name = 'BudgetExceededError'
  }
}

export interface BudgetTicket {
  taskId: string
  lane: OneShotLane
  ticket: string
}

export class BudgetManager {
  private readonly limits: BudgetLimits
  private readonly laneActive: Map<OneShotLane, Set<string>>
  private readonly taskTickets: Map<string, Set<string>>
  private readonly taskHeavy: Map<string, number>

  constructor(limits: Partial<BudgetLimits> = {}) {
    this.limits = { ...DEFAULT_BUDGET_LIMITS, ...limits }
    this.laneActive = new Map<OneShotLane, Set<string>>()
    this.taskTickets = new Map<string, Set<string>>()
    this.taskHeavy = new Map<string, number>()
    for (const lane of ['fast', 'medium', 'heavy'] as const) {
      this.laneActive.set(lane, new Set())
    }
  }

  /** Try to acquire a slot in the requested lane + task. */
  tryAcquire(taskId: string, lane: OneShotLane): BudgetTicket | null {
    // Read once into locals — mid-evaluation re-evaluation of `this.limits` is
    // unnecessary and keeps the check atomic with the lane-limit lookup below.
    const perTaskSize = this.taskTickets.get(taskId)?.size ?? 0
    const perTaskMaxRuns = this.limits.perTaskMaxRuns
    if (perTaskSize >= perTaskMaxRuns) return null
    if (lane === 'heavy' && (this.taskHeavy.get(taskId) ?? 0) >= this.limits.perTaskHeavyRuns) {
      return null
    }
    const laneLimit =
      lane === 'fast'
        ? this.limits.fastConcurrency
        : lane === 'medium'
          ? this.limits.mediumConcurrency
          : this.limits.heavyConcurrency
    const active = this.laneActive.get(lane)!
    if (active.size >= laneLimit) return null

    const ticket = `tkt_${randomBytes(4).toString('hex')}`
    active.add(ticket)
    let perTask = this.taskTickets.get(taskId)
    if (!perTask) {
      perTask = new Set()
      this.taskTickets.set(taskId, perTask)
    }
    perTask.add(ticket)
    if (lane === 'heavy') this.taskHeavy.set(taskId, (this.taskHeavy.get(taskId) ?? 0) + 1)
    return { taskId, lane, ticket }
  }

  release(ticket: BudgetTicket): void {
    const lane = this.laneActive.get(ticket.lane)
    if (lane) lane.delete(ticket.ticket)
    const perTask = this.taskTickets.get(ticket.taskId)
    if (perTask) {
      perTask.delete(ticket.ticket)
      if (perTask.size === 0) this.taskTickets.delete(ticket.taskId)
    }
    if (ticket.lane === 'heavy') {
      const v = this.taskHeavy.get(ticket.taskId) ?? 0
      if (v <= 1) this.taskHeavy.delete(ticket.taskId)
      else this.taskHeavy.set(ticket.taskId, v - 1)
    }
  }

  /** Snapshot of the active per-lane count, useful for Doctor. */
  activeCounts(): { fast: number; medium: number; heavy: number } {
    return {
      fast: this.laneActive.get('fast')!.size,
      medium: this.laneActive.get('medium')!.size,
      heavy: this.laneActive.get('heavy')!.size,
    }
  }

  /** Snapshot of task-level ticket count. */
  taskActive(taskId: string): number {
    return this.taskTickets.get(taskId)?.size ?? 0
  }

  /** Update limits at runtime (Doctor). */
  updateLimits(patch: Partial<BudgetLimits>): void {
    Object.assign(this.limits, patch)
  }

  getLimits(): Readonly<BudgetLimits> {
    return { ...this.limits }
  }
}
