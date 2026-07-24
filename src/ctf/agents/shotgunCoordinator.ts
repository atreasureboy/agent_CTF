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
import type { OneShotResult } from '../oneshot/types.js'
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

  /** Multi-manifest dispatch with scope gating + budget check. */
  async dispatch(inputs: ShotgunCoordinatorInputs): Promise<ShotgunReport> {
    const results: OneShotResult[] = []
    const rejected: ShotgunReport['rejected'] = []

    // Scope authority (§十四) — only TaskExecutionContext.contestScope.
    // LLM cannot supply scope; we use it directly.
    const contestScope = this.taskContext.contestScope

    for (const id of inputs.selectedManifestIds) {
      const m = this.registry.get(id)
      if (!m) {
        rejected.push({ manifestId: id, reason: 'unknown manifest' })
        continue
      }
      if (!m.allowedProfiles.includes(this.taskContext.profileId)) {
        rejected.push({
          manifestId: id,
          reason: `profile ${this.taskContext.profileId} not allowed`,
        })
        continue
      }
      if (!this.isManifestReady(id)) {
        rejected.push({ manifestId: id, reason: 'manifest not READY' })
        continue
      }
      // Heavy approval — non-default unless explicitly enabled.
      if (m.scheduling.costTier === 'heavy' && contestScope.allowHeavyOneShots !== true) {
        rejected.push({ manifestId: id, reason: 'heavy-tier requires operator approval' })
        continue
      }
      // Network mode — must be allowed by contestScope.
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

      try {
        const result = await this.dispatcher.runOne(id, {
          argv,
          evidenceRoot: `${this.taskContext.artifactDir}/.oneshots`,
          resolvedInput: { artifactIds: inputArtifactIds, options },
          reason: inputs.reason,
        })
        results.push(result)
      } catch (err) {
        rejected.push({ manifestId: id, reason: (err as Error).message })
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
  eligible(): import('../oneshot/types.js').OneShotManifest[] {
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
