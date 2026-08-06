/**
 * CrossChallengeCache — shared state across challenges in a competition batch.
 *
 * Purpose: When the system solves challenge A (category=crypto, keyword=RSA)
 * using `rsactftool`, challenge B with similar fingerprints should bypass
 * the classifier and go straight to the same tool.
 *
 * Lifecycle: One cache per batchSolve invocation. Shared across all leaf
 * tasks in the pool. Not persisted to disk.
 *
 * §Round-5 — cross-task learning speeds up batches where many challenges
 * share the same category/solving pattern.
 */

export interface PatternRecord {
  /** The challenge category that triggered this pattern. */
  category: string
  /** Keywords extracted from the challenge description. */
  keywords: string[]
  /** The tool or manifest that solved it. */
  solver: string
  /** How long it took (ms). */
  elapsedMs: number
  /** Whether it was fast-path or LLM-driven. */
  path: 'fast' | 'medium' | 'heavy'
  /** Timestamp when recorded. */
  recordedAt: number
}

export interface SuggestedApproach {
  /** Recommended manifest ID(s) for oneshot dispatch. */
  manifests: string[]
  /** Recommended profile for LLM agent dispatch. */
  profile: string
  /** Confidence in this suggestion (0-1). */
  confidence: number
  /** Why this was suggested. */
  reason: string
}

/**
 * Tracks tool-level success rates to guide future dispatch decisions.
 * Per-tool `{tries, successes}` gives a simple probability estimate.
 */
interface ToolStats {
  tries: number
  successes: number
  /** Total elapsed time across all successful runs (ms). */
  totalSuccessTimeMs: number
}

/** Cap on solvedPatterns to prevent unbounded growth in large batches. */
const MAX_PATTERNS = 500

export class CrossChallengeCache {
  /** Successful solve patterns, keyed by category + keyword intersection. */
  private solvedPatterns: PatternRecord[] = []
  /** Tool-level success stats. */
  private toolStats = new Map<string, ToolStats>()
  /** How many challenges have been recorded. */
  private totalRecorded = 0

  /**
   * Record a successful solve. The cache extracts reusable patterns.
   */
  recordSuccess(
    category: string,
    description: string,
    solver: string,
    path: 'fast' | 'medium' | 'heavy',
    elapsedMs: number,
  ): void {
    const keywords = this.extractKeywords(description)
    this.solvedPatterns.push({
      category,
      keywords,
      solver,
      elapsedMs,
      path,
      recordedAt: Date.now(),
    })

    // §Audit — Evict oldest patterns when we exceed the cap (FIFO).
    // This prevents unbounded growth during very large competition batches.
    while (this.solvedPatterns.length > MAX_PATTERNS) {
      this.solvedPatterns.shift()
    }
    this.totalRecorded++

    // Update tool stats
    let stats = this.toolStats.get(solver)
    if (!stats) {
      stats = { tries: 0, successes: 0, totalSuccessTimeMs: 0 }
    }
    stats.tries++
    stats.successes++
    stats.totalSuccessTimeMs += elapsedMs
    this.toolStats.set(solver, stats)
  }

  /**
   * Record a failure for a tool. Helps deprioritize unreliable tools.
   */
  recordFailure(solver: string): void {
    let stats = this.toolStats.get(solver)
    if (!stats) {
      stats = { tries: 0, successes: 0, totalSuccessTimeMs: 0 }
    }
    stats.tries++
    this.toolStats.set(solver, stats)
  }

  /**
   * Suggest an approach for a new challenge based on past successes.
   * Returns null if no good match is found.
   */
  suggest(category: string, description: string): SuggestedApproach | null {
    const normalizedCategory = category.toLowerCase()
    const keywords = this.extractKeywords(description)

    // Find patterns with matching category
    const categoryPatterns = this.solvedPatterns.filter(
      (p) => p.category.toLowerCase() === normalizedCategory,
    )

    if (categoryPatterns.length === 0) {
      // Try tool stats as fallback
      const bestTool = this.getBestTool()
      if (bestTool) {
        return {
          manifests: [bestTool],
          profile: normalizedCategory,
          confidence: 0.3,
          reason: `no category match; best tool overall: ${bestTool}`,
        }
      }
      return null
    }

    // Score each pattern by keyword overlap
    let bestPattern: PatternRecord | null = null
    let bestScore = 0

    for (const pattern of categoryPatterns) {
      const overlap = pattern.keywords.filter((k) => keywords.includes(k)).length
      const score = overlap / Math.max(pattern.keywords.length, 1)
      if (score > bestScore) {
        bestScore = score
        bestPattern = pattern
      }
    }

    if (bestPattern) {
      return {
        manifests: bestPattern.path === 'fast' ? [bestPattern.solver] : [],
        profile: bestPattern.path !== 'fast' ? bestPattern.solver : normalizedCategory,
        confidence: Math.min(0.5 + bestScore * 0.4, 0.9),
        reason: `matched pattern: ${bestPattern.category}/${bestPattern.solver} (${bestScore.toFixed(2)} overlap)`,
      }
    }

    // No keyword overlap, but same category — suggest the most common solver
    const solverCounts = new Map<string, number>()
    for (const p of categoryPatterns) {
      solverCounts.set(p.solver, (solverCounts.get(p.solver) ?? 0) + 1)
    }
    const mostCommon = [...solverCounts.entries()].sort((a, b) => b[1] - a[1])[0]

    return {
      manifests: [],
      profile: mostCommon ? mostCommon[0] : normalizedCategory,
      confidence: 0.4,
      reason: `same category (${normalizedCategory}), most common: ${mostCommon?.[0] ?? 'unknown'}`,
    }
  }

  /**
   * Get the best-performing tool across all categories.
   */
  private getBestTool(): string | null {
    let best: string | null = null
    let bestRate = 0

    for (const [tool, stats] of this.toolStats) {
      if (stats.tries < 2) continue // not enough data
      const rate = stats.successes / stats.tries
      if (rate > bestRate) {
        bestRate = rate
        best = tool
      }
    }

    return best
  }

  /**
   * Command tool success rate (for metrics / progress reporting).
   */
  getToolSuccessRate(toolId: string): number {
    const stats = this.toolStats.get(toolId)
    if (!stats || stats.tries === 0) return Number.NaN
    return stats.successes / stats.tries
  }

  /**
   * Extract meaningful keywords from a challenge description.
   */
  private extractKeywords(description: string): string[] {
    const text = description.toLowerCase()
    const keywords: string[] = []

    const PATTERNS = [
      /\b(rsa|aes|base64|hex|rot\d+|caesar|morse|vigenere|xor)\b/gi,
      /\b(png|jpe?g|gif|bmp|pcap|pcapng|zip|tar|gz|elf|pe|exe)\b/gi,
      /\b(sql|injection|xss|csrf|ssrf|rce|overflow|shellcode|rop)\b/gi,
      /\b(stego|lsb|metadata|exif|binwalk|strings|file|forensic)\b/gi,
      /\b(encode|decode|decrypt|encrypt|cipher|crack|brute)\b/gi,
    ]

    for (const pattern of PATTERNS) {
      const matches = text.matchAll(pattern)
      for (const m of matches) {
        keywords.push(m[0].toLowerCase())
      }
    }

    return [...new Set(keywords)]
  }

  /** How many patterns have been recorded. */
  getTotalRecorded(): number {
    return this.totalRecorded
  }

  /** Clear all cached data. */
  clear(): void {
    this.solvedPatterns = []
    this.toolStats.clear()
    this.totalRecorded = 0
  }
}
