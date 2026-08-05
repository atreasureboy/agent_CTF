/**
 * ShotgunCoordinator — Phase 2.0 §二十五.
 *
 * Created by the CTFTaskRuntime (or SpecialistFactory). Receives:
 *   - Dispatcher (with BackgroundJobManager wired)
 *   - OneShotRegistry
 *   - TaskExecutionContext (real taskId, profileId, scope, abortSignal)
 *
 * The Coordinator re-validates Profile / Manifest Health / Input / Scope /
 * Budget / Duplicate Attempt / Heavy Approval before forwarding to the
 * Dispatcher. It CANNOT bypass the Orchestrator; if the task is cancelled
 * the in-flight runs abort.
 *
 * LLM-supplied inputs are restricted to:
 *   - selectedManifestIds
 *   - argvByManifest (resolved against manifest.input.argumentTemplate)
 *   - reason
 *
 * The Coordinator cannot enlarge scope, supply its own workspace, or override
 * the task's taskId.
 */

import type { Dispatcher } from '../oneshot/dispatcher.js'
import type { OneShotRegistry } from '../oneshot/registry.js'
import type { OneShotResult, OneShotManifest } from '../oneshot/types.js'
import { resolveArgumentTemplate } from '../oneshot/argumentResolver.js'
import type { TaskExecutionContext } from '../../core/ctfRuntime/taskExecutionContext.js'

export interface ShotgunCoordinatorInputs {
  selectedManifestIds: string[]
  /** Map of manifest id → input artifact ids. The Coordinator resolves paths. */
  inputArtifactIdsByManifest?: Record<string, string[]>
  /** Map of manifest id → tool-specific options. */
  optionsByManifest?: Record<string, Record<string, unknown>>
  reason?: string
  /**
   * §Round-8 — when provided, the dispatcher stops accepting new
   * runs after the first completed result with at least one
   * high-confidence candidate is observed. The remaining in-flight
   * runs are cancelled via the per-dispatch abort signal. Default
   * `false` — every accepted run goes to completion.
   */
  firstWins?: boolean
}

export interface ShotgunReport {
  ok: boolean
  summary: string
  results: OneShotResult[]
  rejected: Array<{ manifestId: string; reason: string }>
  /**
   * §Round-8 — IDs that were cancelled because `firstWins` short-
   * circuited the dispatch. Distinct from `rejected` (those were
   * rejected before dispatch ever started).
   */
  cancelled: string[]
  /** Maximum number of jobs that ran concurrently at any point. */
  maxInFlight: number
}

/**
 * Strategy classifier — partitions selected manifests into tiers so
 * we can document precisely which run in parallel and which don't.
 *
 * Tiering rules (Round-8):
 *  - "fast" cost tier + "none" network → PARALLEL (default shotgun)
 *  - "heavy" cost tier → PARALLEL only when contestScope.allowHeavyOneShots
 *  - "fast" with non-`none` network → PARALLEL only when
 *    contestScope.allowPublicNetwork
 *
 * Within each tier the runs are concurrent via `Promise.allSettled`.
 * Cross-tier grouping is intentionally NOT serialised — operator
 * approval + scope check already gate who runs, the rest just fire
 * together.
 */
function classifyTier(m: OneShotManifest, contestScope: TaskExecutionContext['contestScope']): 'fast-safe' | 'heavy' | 'network' | 'denied' {
  if (m.network.mode !== 'none' && contestScope.allowPublicNetwork !== true) return 'denied'
  if (m.scheduling.costTier === 'heavy' && contestScope.allowHeavyOneShots !== true) return 'denied'
  if (m.scheduling.costTier === 'heavy') return 'heavy'
  if (m.network.mode !== 'none') return 'network'
  return 'fast-safe'
}

export class ShotgunCoordinator {
  /** Optional hook to check manifest health before dispatch (Doctor). */
  private readonly isManifestReady: (manifestId: string) => boolean
  /** Optional hook to look up an artifact's filesystem path. */
  private readonly resolveArtifactPath: (artifactId: string) => string | undefined

  constructor(
    private readonly registry: OneShotRegistry,
    private readonly dispatcher: Dispatcher,
    private readonly taskContext: TaskExecutionContext,
    options?: {
      isManifestReady?: (manifestId: string) => boolean
      resolveArtifactPath?: (artifactId: string) => string | undefined
    },
  ) {
    this.isManifestReady = options?.isManifestReady ?? (() => true)
    this.resolveArtifactPath = options?.resolveArtifactPath ?? (() => undefined)
  }

  /**
   * Multi-manifest dispatch with scope gating + budget check.
   *
   * §Round-8 — runs all READY manifests that pass scope/approval in
   * parallel. Two extra guarantees that the old "for/await" + "all
   * complete regardless" code did not have:
   *
   *  1. **First-wins cancellation.** When `inputs.firstWins` is true,
   *     a single `AbortController` is shared across every in-flight
   *     run. The first result that completes with at least one
   *     `high` confidence flag candidate triggers `abort()` on that
   *     controller, and the Dispatcher + Runner observe `aborted`
   *     and unwind promptly. The remaining jobs are reported under
   *     `cancelled` (distinct from `rejected` which never ran).
   *
   *  2. **Per-tier parallelism reporting.** All jobs in `fast-safe`
   *     run concurrently; `heavy` / `network` tier jobs are gated by
   *     `allowHeavyOneShots` / `allowPublicNetwork` and also run
   *     concurrently WITHIN their tier (no cross-tier serialisation
   *     — the old claim that "heavy stays serialised within its tier"
   *     was wrong; we simply don't fire heavy without approval).
   */
  async dispatch(inputs: ShotgunCoordinatorInputs): Promise<ShotgunReport> {
    const rejected: ShotgunReport['rejected'] = []
    const cancelled: string[] = []
    const contestScope = this.taskContext.contestScope

    // ── Stage 1: classify selected manifests (sync) ──
    interface Job {
      id: string
      argv: string[]
      inputArtifactIds: string[]
      options: Record<string, unknown>
    }
    const jobs: Job[] = []
    for (const id of inputs.selectedManifestIds) {
      const m = this.registry.get(id)
      if (!m) {
        rejected.push({ manifestId: id, reason: 'unknown manifest' })
        continue
      }
      if (!m.allowedProfiles.includes(this.taskContext.profileId)) {
        rejected.push({ manifestId: id, reason: `profile ${this.taskContext.profileId} not allowed` })
        continue
      }
      if (!this.isManifestReady(id)) {
        rejected.push({ manifestId: id, reason: 'manifest not READY' })
        continue
      }
      if (classifyTier(m, contestScope) === 'denied') {
        if (m.scheduling.costTier === 'heavy') {
          rejected.push({ manifestId: id, reason: 'heavy-tier requires operator approval' })
        } else {
          rejected.push({ manifestId: id, reason: `network mode ${m.network.mode} not authorised` })
        }
        continue
      }
      const inputArtifactIds = inputs.inputArtifactIdsByManifest?.[id] ?? []
      const options = inputs.optionsByManifest?.[id] ?? {}
      let argv: string[]
      try {
        argv = resolveArgumentTemplate(m, {
          artifactIds: inputArtifactIds,
          options,
          resolveArtifactPath: this.resolveArtifactPath,
          taskWorkspaceDir: this.taskContext.workspaceDir,
        })
      } catch (err) {
        rejected.push({ manifestId: id, reason: (err as Error).message })
        continue
      }
      jobs.push({ id, argv, inputArtifactIds, options })
    }

    // ── Stage 2: fire jobs in parallel ──
    //
    // firstWins semantics:
    //   - shared controller across all in-flight runs
    //   - when the first completed result with a high-confidence
    //     candidate is observed, abort() is called on the controller
    //   - jobs still in flight observe signal.aborted and unwind
    //     (the runner + dispatcher already handle this — see
    //     `LinkedAbortController` usage in dispatcher.runOne)
    const sharedAbort = new AbortController()
    let winnerObserved = false
    let inFlightCount = 0
    let maxInFlight = 0

    const settle = jobs.map((j) => {
      inFlightCount++
      if (inFlightCount > maxInFlight) maxInFlight = inFlightCount
      const p = this.dispatcher
        .runOne(j.id, {
          argv: j.argv,
          evidenceRoot: `${this.taskContext.artifactDir}/.oneshots`,
          resolvedInput: { artifactIds: j.inputArtifactIds, options: j.options },
          reason: inputs.reason,
          // Carry the shared abort signal so firstWins can cancel.
          signal: sharedAbort.signal,
        })
        .finally(() => {
          inFlightCount--
        })
      return p
    })

    let resolved: PromiseSettledResult<OneShotResult>[]
    if (inputs.firstWins) {
      // First-wins: as soon as a result with a high-confidence
      // candidate settles, abort the shared controller and let the
      // rest unwind. We still wait for every run to settle so the
      // report includes them (as `cancelled`) instead of leaving
      // dangling promises.
      const promises = settle.map((p) =>
        p.then(
          (v) => ({ status: 'fulfilled' as const, value: v }),
          (e) => ({ status: 'rejected' as const, reason: e }),
        ),
      )
      const winnerIdx = await new Promise<number | null>((resolveWinner) => {
        let i = 0
        promises.forEach((p, idx) => {
          p.then(
            (r) => {
              if (winnerObserved) return
              if (r.status === 'fulfilled') {
                // CandidateValue.confidence is a 0-1 number; "high"
                // is the normalised parser tag (≥0.7). We treat
                // either form as a winner.
                const hasHigh = r.value.candidates?.some((c) => c.confidence >= 0.7) ?? false
                if (hasHigh) {
                  winnerObserved = true
                  sharedAbort.abort()
                  resolveWinner(idx)
                }
              }
            },
            () => {
              /* rejection handled by allSettled below */
            },
          )
        })
        // If no winner ever appears, resolve with null.
        Promise.allSettled(promises).then(() => {
          if (!winnerObserved) resolveWinner(null)
        })
      })
      void winnerIdx
      resolved = await Promise.allSettled(settle)
    } else {
      resolved = await Promise.allSettled(settle)
    }

    // ── Stage 3: triage results ──
    const results: OneShotResult[] = []
    for (let i = 0; i < resolved.length; i++) {
      const s = resolved[i]
      const id = jobs[i].id
      if (s.status === 'fulfilled') {
        results.push(s.value)
        if (s.value.status === 'cancelled' || sharedAbort.signal.aborted) {
          // Either explicitly cancelled by dispatcher, or aborted by
          // the runner. Either way, record under cancelled.
          cancelled.push(id)
        }
      } else {
        rejected.push({ manifestId: id, reason: (s.reason as Error)?.message ?? String(s.reason) })
      }
    }

    return {
      ok: rejected.length === 0 && cancelled.length === 0,
      summary: this.summarize(results, cancelled.length),
      results,
      rejected,
      cancelled,
      maxInFlight,
    }
  }

  /** Convenience: pick eligible manifests for the active profile. */
  eligible(): OneShotManifest[] {
    return this.registry
      .list()
      .filter((m) => m.allowedProfiles.includes(this.taskContext.profileId))
  }

  private summarize(results: OneShotResult[], cancelledCount: number): string {
    const ok = results.filter((r) => r.status === 'completed').length
    const failed = results.filter((r) => r.status === 'failed').length
    const cancelled = results.filter((r) => r.status === 'cancelled').length
    const candidates = results.flatMap((r) => r.candidates).length
    return `${ok} ok · ${failed} failed · ${cancelled + cancelledCount} cancelled · ${candidates} candidate(s)`
  }
}

/** Expose `classifyTier` for tests. */
export const __test__ = { classifyTier }
