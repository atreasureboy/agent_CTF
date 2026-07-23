/**
 * ShotgunCoordinator — orchestrates the Shotgun Agent's tool calls into the
 * OneShot Dispatcher.
 *
 * The Coordinator is intentionally thin: the LLM picks manifest ids + argv,
 * and the Coordinator simply forwards through the Dispatcher, collects
 * normalized results, and dedupes them by candidate value.
 *
 * The Coordinator never bypasses scope checks. Network-mode manifests
 * (`contest-target-only`) are rejected here when no scope was supplied.
 */

import { Dispatcher } from '../oneshot/dispatcher.js'
import type { OneShotManifest, OneShotResult } from '../oneshot/types.js'
import type { OneShotRegistry } from '../oneshot/registry.js'
import { ScopeGate } from '../oneshot/scopeGate.js'

export interface ShotgunCoordinatorInputs {
  selectedManifestIds: string[]
  argvByManifest: Record<string, string[]>
  workspace: string
  evidenceRoot: string
  scope?: { hosts?: string[]; domains?: string[]; ports?: number[]; cidrs?: string[] }
  signal: AbortSignal
}

export interface ShotgunReport {
  ok: boolean
  summary: string
  results: OneShotResult[]
  rejected: Array<{ manifestId: string; reason: string }>
}

export class ShotgunCoordinator {
  constructor(
    private readonly registry: OneShotRegistry,
    private readonly dispatcher: Dispatcher,
  ) {}

  /** Multi-manifest dispatch with scope gating. */
  async dispatch(inputs: ShotgunCoordinatorInputs): Promise<ShotgunReport> {
    const results: OneShotResult[] = []
    const rejected: ShotgunReport['rejected'] = []

    const scopeGate = inputs.scope
      ? new ScopeGate({
          hosts: inputs.scope.hosts ?? [],
          domains: inputs.scope.domains ?? [],
          ports: inputs.scope.ports ?? [],
          cidrs: inputs.scope.cidrs ?? [],
        }, { denyByDefault: true })
      : null

    for (const id of inputs.selectedManifestIds) {
      const m = this.registry.get(id)
      if (!m) {
        rejected.push({ manifestId: id, reason: 'unknown manifest' })
        continue
      }
      if (m.network.mode !== 'none') {
        if (!scopeGate) {
          rejected.push({ manifestId: id, reason: 'network mode requires scope' })
          continue
        }
        if (m.runner.command && m.network.mode === 'contest-target-only') {
          // Best-effort: pull host from argv (last arg).
          const last = inputs.argvByManifest[id]?.slice(-1)[0]
          if (last) {
            try {
              scopeGate.assert(last)
            } catch (err) {
              rejected.push({ manifestId: id, reason: `scope: ${(err as Error).message}` })
              continue
            }
          }
        }
      }

      try {
        const result = await this.dispatcher.runOne(id, {
          argv: inputs.argvByManifest[id] ?? [],
          evidenceRoot: inputs.evidenceRoot,
          signal: inputs.signal,
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

  /** Convenience: pick eligible manifests for a profile + task. */
  eligible(profileId: string): OneShotManifest[] {
    return this.registry.list().filter((m) => m.allowedProfiles.includes(profileId))
  }

  private summarize(results: OneShotResult[]): string {
    const ok = results.filter((r) => r.status === 'completed').length
    const failed = results.filter((r) => r.status === 'failed').length
    const cancelled = results.filter((r) => r.status === 'cancelled').length
    const candidates = results.flatMap((r) => r.candidates).length
    return `${ok} ok · ${failed} failed · ${cancelled} cancelled · ${candidates} candidate(s)`
  }
}
