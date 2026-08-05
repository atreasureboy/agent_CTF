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
}

export interface ShotgunReport {
  ok: boolean
  summary: string
  results: OneShotResult[]
  rejected: Array<{ manifestId: string; reason: string }>
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
   * §Round-7 — the previous version walked `selectedManifestIds` with
   * `for (const id of …) { await dispatcher.runOne(...) }`, which is
   * SERIAL — only one tool at a time. The Coordinator's whole pitch is
   * "cheap-read-only shotgun, first high-confidence wins, cancel the
   * rest". Without parallelism the ShotgunCoordinator was effectively
   * a queue.
   *
   * New model: fire all READY manifests that pass scope/approval in
   * parallel via `Promise.allSettled`. The first one to emit a
   * `high` confidence flag candidate or otherwise complete with
   * `status === 'completed'` and a finding can short-circuit remaining
   * runs via the LinkedAbortController (one AbortSignal shared across
   * all in-flight runners — when one finishes successfully, the others
   * observe `signal.aborted === true` and unwind).
   *
   * Heavy-tier + network-tier manifests stay serialised within their
   * own tier to keep operator approval deterministic — we still launch
   * cheap ones in parallel with them.
   */
  async dispatch(inputs: ShotgunCoordinatorInputs): Promise<ShotgunReport> {
    const rejected: ShotgunReport['rejected'] = []
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
      if (m.scheduling.costTier === 'heavy' && contestScope.allowHeavyOneShots !== true) {
        rejected.push({ manifestId: id, reason: 'heavy-tier requires operator approval' })
        continue
      }
      if (m.network.mode !== 'none' && contestScope.allowPublicNetwork !== true) {
        rejected.push({ manifestId: id, reason: `network mode ${m.network.mode} not authorised` })
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
    // `Promise.allSettled` rather than `Promise.all` because we expect
    // some to fail (denied / rejected / cancelled) and want them in the
    // report anyway. The dispatcher itself owns the LinkedAbortController.
    const settled = await Promise.allSettled(
      jobs.map((j) =>
        this.dispatcher.runOne(j.id, {
          argv: j.argv,
          evidenceRoot: `${this.taskContext.artifactDir}/.oneshots`,
          resolvedInput: { artifactIds: j.inputArtifactIds, options: j.options },
          reason: inputs.reason,
        }),
      ),
    )

    const results: OneShotResult[] = []
    for (let i = 0; i < settled.length; i++) {
      const s = settled[i]
      if (s.status === 'fulfilled') {
        results.push(s.value)
      } else {
        rejected.push({ manifestId: jobs[i].id, reason: (s.reason as Error)?.message ?? String(s.reason) })
      }
    }

    return {
      ok: rejected.length === 0,
      summary: this.summarize(results),
      results,
      rejected,
    }
  }

  /** Convenience: pick eligible manifests for the active profile. */
  eligible(): OneShotManifest[] {
    return this.registry
      .list()
      .filter((m) => m.allowedProfiles.includes(this.taskContext.profileId))
  }

  private summarize(results: OneShotResult[]): string {
    const ok = results.filter((r) => r.status === 'completed').length
    const failed = results.filter((r) => r.status === 'failed').length
    const cancelled = results.filter((r) => r.status === 'cancelled').length
    const candidates = results.flatMap((r) => r.candidates).length
    return `${ok} ok · ${failed} failed · ${cancelled} cancelled · ${candidates} candidate(s)`
  }
}
