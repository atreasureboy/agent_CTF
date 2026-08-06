/**
 * AdaptiveConcurrencyController — sliding-window success-rate tracker
 * that adjusts task concurrency at runtime.
 *
 * Strategy:
 *   - successRate > 85% → increase concurrency (+2, capped at max)
 *   - successRate < 40% → decrease concurrency (-1, floored at min)
 *   - 40-85% → hold steady
 *
 * The window is a sliding buffer of the last N results (default 20).
 * Adjustments only fire after at least 5 results have been observed
 * to avoid over-reacting to initial noise.
 */

export interface AdaptiveConcurrencyConfig {
  /** Starting concurrency (default 4). */
  initialConcurrency: number
  /** Floor (default 1). */
  minConcurrency?: number
  /** Ceiling (default 16). */
  maxConcurrency?: number
  /** Sliding window size (default 20). */
  windowSize?: number
  /** Success-rate threshold above which we increase (default 0.85). */
  increaseThreshold?: number
  /** Success-rate threshold below which we decrease (default 0.40). */
  decreaseThreshold?: number
  /** How many results before we start adjusting (default 5). */
  warmupCount?: number
  /** How much to add per increase step (default 2). */
  increaseStep?: number
}

export class AdaptiveConcurrencyController {
  private readonly successWindow: boolean[] = []
  private readonly windowSize: number
  private readonly minConcurrency: number
  private readonly maxConcurrency: number
  private currentConcurrency: number
  private readonly increaseThreshold: number
  private readonly decreaseThreshold: number
  private readonly warmupCount: number
  private readonly increaseStep: number
  private totalSolved = 0
  private totalFailed = 0

  constructor(config: AdaptiveConcurrencyConfig) {
    if (!Number.isInteger(config.initialConcurrency) || config.initialConcurrency <= 0) {
      throw new Error('initialConcurrency must be a positive integer')
    }
    this.currentConcurrency = config.initialConcurrency
    this.minConcurrency = config.minConcurrency ?? 1
    this.maxConcurrency = config.maxConcurrency ?? 16
    this.windowSize = config.windowSize ?? 20
    this.increaseThreshold = config.increaseThreshold ?? 0.85
    this.decreaseThreshold = config.decreaseThreshold ?? 0.4
    this.warmupCount = config.warmupCount ?? 5
    this.increaseStep = config.increaseStep ?? 2
  }

  /**
   * Record a task result. Returns the new recommended concurrency.
   * Callers should apply the returned value to their pool's max slots.
   */
  recordResult(success: boolean): number {
    if (success) {
      this.totalSolved++
    } else {
      this.totalFailed++
    }

    this.successWindow.push(success)
    if (this.successWindow.length > this.windowSize) {
      this.successWindow.shift()
    }
    return this.recalculate()
  }

  private recalculate(): number {
    if (this.successWindow.length < this.warmupCount) {
      return this.currentConcurrency
    }

    const successRate = this.successWindow.filter(Boolean).length / this.successWindow.length

    if (successRate > this.increaseThreshold) {
      this.currentConcurrency = Math.min(
        this.maxConcurrency,
        this.currentConcurrency + this.increaseStep,
      )
    } else if (successRate < this.decreaseThreshold) {
      this.currentConcurrency = Math.max(this.minConcurrency, this.currentConcurrency - 1)
    }
    // else: hold steady

    return this.currentConcurrency
  }

  /** Current recommended concurrency (does not trigger recalculation). */
  getConcurrency(): number {
    return this.currentConcurrency
  }

  /** Current success rate (0-1, NaN if no data). */
  getSuccessRate(): number {
    if (this.successWindow.length === 0) return Number.NaN
    return this.successWindow.filter(Boolean).length / this.successWindow.length
  }

  /** Cumulative counts since creation. */
  getCounts(): { solved: number; failed: number; total: number } {
    return {
      solved: this.totalSolved,
      failed: this.totalFailed,
      total: this.totalSolved + this.totalFailed,
    }
  }

  /** Reset to initial state (useful for testing). */
  reset(): void {
    this.successWindow.length = 0
    this.totalSolved = 0
    this.totalFailed = 0
    this.currentConcurrency = this.minConcurrency
  }
}
