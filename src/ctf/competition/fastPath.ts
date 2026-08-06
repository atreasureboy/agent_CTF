/**
 * FastPath — zero-LLM execution path for competition solving.
 *
 * When the ChallengeClassifier determines a challenge is "fast" (e.g.
 * simple base64 encoding, text search, image metadata extraction), this
 * module runs the recommended oneshot manifests directly through the
 * Dispatcher and extracts flag candidates — no LLM turns, no harness
 * overhead, no token cost.
 *
 * If no flag is found, the caller should escalate to the medium or
 * heavy path (ShotgunCoordinator or LLM agent).
 */

import { type Dispatcher, type DispatcherInputs } from '../oneshot/dispatcher.js'
import type { OneShotResult } from '../oneshot/types.js'
import type { TaskExecutorResult } from '../../core/ctfRuntime/challengeConcurrencyPool.js'

// ── Configuration ─────────────────────────────────────────────────────────

export interface FastPathConfig {
  /** Max oneshot manifests to run (default 3). */
  maxManifests: number
  /** Timeout per manifest in ms (default 30_000). */
  perManifestTimeoutMs: number
  /** Min candidate confidence to treat as a solution (default 0.7). */
  minConfidence: number
}

const DEFAULT_CONFIG: FastPathConfig = {
  maxManifests: 3,
  perManifestTimeoutMs: 30_000,
  minConfidence: 0.7,
}

// ── Result ────────────────────────────────────────────────────────────────

export interface FastPathResult {
  flag: string | undefined
  /** Which manifest found the flag (if any). */
  solvedBy?: string
  /** All candidate values found (including low-confidence). */
  allCandidates: string[]
  /** Results from every manifest that ran. */
  runResults: OneShotResult[]
}

// ── Main entry point ─────────────────────────────────────────────────────

/**
 * Run the fast-path pipeline for a challenge.
 *
 * 1. Abort early if the parent signal is already aborted.
 * 2. Run up to `config.maxManifests` oneshot manifests in sequence.
 * 3. Collect flag candidates from each result.
 * 4. Return the first high-confidence candidate as the flag.
 */
export async function runFastPath(
  manifestIds: string[],
  dispatcher: Dispatcher,
  signal: AbortSignal,
  config: Partial<FastPathConfig> = {},
): Promise<FastPathResult> {
  const cfg = { ...DEFAULT_CONFIG, ...config }

  if (signal.aborted) {
    return { flag: undefined, allCandidates: [], runResults: [] }
  }

  if (manifestIds.length === 0) {
    return { flag: undefined, allCandidates: [], runResults: [] }
  }

  // Limit to max manifests
  const toRun = manifestIds.slice(0, cfg.maxManifests)
  const runResults: OneShotResult[] = []
  const allCandidates: string[] = []

  for (const manifestId of toRun) {
    // Check abort between runs
    if (signal.aborted) break

    try {
      const perRunSignal = AbortSignal.any([signal, AbortSignal.timeout(cfg.perManifestTimeoutMs)])

      const inputs: DispatcherInputs = {
        argv: [],
        evidenceRoot: `.ovogo/oneshot_evidence`,
        signal: perRunSignal,
        reason: `fast-path: ${manifestId}`,
      }

      const result = await dispatcher.runOne(manifestId, inputs)
      runResults.push(result)

      // Collect candidates
      for (const c of result.candidates) {
        allCandidates.push(c.value)
      }

      // Check if we found a solution
      if (result.candidates.length > 0) {
        const best = result.candidates.reduce((a, b) => (b.confidence > a.confidence ? b : a))
        if (best.confidence >= cfg.minConfidence) {
          return {
            flag: best.value,
            solvedBy: manifestId,
            allCandidates,
            runResults,
          }
        }
      }

      // Also check findings for flag-like content
      for (const f of result.findings) {
        const flagMatch = f.summary.match(/flag\{[^}]+\}/i)
        if (flagMatch) {
          allCandidates.push(flagMatch[0])
          if (f.confidence === 'high') {
            return {
              flag: flagMatch[0],
              solvedBy: manifestId,
              allCandidates,
              runResults,
            }
          }
        }
      }
    } catch {
      // Manifest failed — continue to next one
      continue
    }
  }

  return { flag: undefined, allCandidates, runResults }
}

/**
 * Convert FastPathResult to TaskExecutorResult for the concurrency pool.
 */
export function toTaskExecutorResult(result: FastPathResult): TaskExecutorResult {
  if (result.flag) {
    return { status: 'solved', flag: result.flag }
  }
  return { status: 'failed', flag: undefined }
}
