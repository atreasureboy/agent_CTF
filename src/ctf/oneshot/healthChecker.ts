/**
 * HealthChecker — produces the READY/DEGRADED/.../UNAVAILABLE state per
 * manifest for the Doctor command.
 *
 * The check is intentionally cheap and synchronous-first. Heavy probes
 * happen only when the operator explicitly invokes the checker.
 */

import { spawnSync } from 'child_process'
import { request as httpRequest } from 'http'
import { request as httpsRequest } from 'https'
import { URL } from 'url'
import type {
  DoctorRow,
  DoctorStatus,
  OneShotManifest,
} from './types.js'
import type { OneShotCatalog } from './catalog.js'

export interface HealthCheckerDeps {
  catalog: OneShotCatalog
  /** Default: true in production, false in tests. */
  execute?: boolean
  /** §P1 audit fix — sync Doctor needs to know whether the network adapter
   *  is wired so the `contest-target-only` gate can fire. */
  networkAdapterPresent?: boolean
  outboundReadonlyApproved?: boolean
}

export interface HealthOptions {
  /** Network probes may be enabled here (default false — avoid side effects). */
  enableNetwork?: boolean
  /** §十四 — set when a network adapter is wired for `contest-target-only`. */
  networkAdapterPresent?: boolean
  /** §十四 — set when `outbound-readonly` is operator-approved. */
  outboundReadonlyApproved?: boolean
}

const HEAVY_MANIFESTS = new Set([
  'crypto-attacks',
  'angr',
  'mobsf',
  'fact-core',
  'emba',
  'reconftw',
  'volatility3-full',
])

export class HealthChecker {
  constructor(private readonly deps: HealthCheckerDeps) {}

  async checkManifest(manifest: OneShotManifest, opts: HealthOptions = {}): Promise<DoctorRow> {
    const row: DoctorRow = {
      category: manifest.category,
      manifestId: manifest.id,
      displayName: manifest.displayName,
      status: 'UNAVAILABLE',
    }

    // Maturity gate.
    if (manifest.maturity === 'experimental' && !manifest.enabledByDefault) {
      row.status = 'DEGRADED'
      row.reason = 'experimental + disabled by default'
      return row
    }

    if (
      manifest.scheduling.costTier === 'heavy' &&
      !manifest.enabledByDefault
    ) {
      // Heavy-tier manifests require explicit enable per §十四.
      row.status = 'DISABLED_HEAVY'
      row.reason = 'heavy tier requires explicit enable'
      return row
    }

    // §十五 — container manifests MUST carry imageDigest for
    // stable/candidate maturity. `:latest` is forbidden.
    if (manifest.runner.type === 'container' && manifest.maturity !== 'experimental') {
      if (!manifest.source.imageDigest) {
        row.status = 'DEGRADED'
        row.reason = 'image not pinned (imageDigest missing)'
        return row
      }
      // Digest format: sha256:HEX (≥64 hex).
      if (!/^sha256:[a-f0-9]{64}$/.test(manifest.source.imageDigest)) {
        row.status = 'DEGRADED'
        row.reason = `imageDigest format invalid: ${manifest.source.imageDigest}`
        return row
      }
      if (manifest.runner.image && manifest.runner.image.endsWith(':latest')) {
        row.status = 'DEGRADED'
        row.reason = 'image uses :latest tag'
        return row
      }
    }

    // Network required but no scope → DISABLED_SCOPE_REQUIRED.
    if (
      manifest.network.mode !== 'none' &&
      manifest.network.requiresScopeApproval &&
      !manifest.enabledByDefault
    ) {
      row.status = 'DISABLED_SCOPE_REQUIRED'
      row.reason = 'network mode requires scope approval'
      return row
    }

    // §十四 — `contest-target-only` requires a network adapter; without
    // one we cannot claim "contest-only" isolation.
    if (manifest.network.mode === 'contest-target-only' && !opts.networkAdapterPresent) {
      row.status = 'DISABLED_SCOPE_REQUIRED'
      row.reason = 'contest-target-only requires configured network adapter'
      return row
    }

    // §十四 — `outbound-readonly` requires explicit operator opt-in.
    if (manifest.network.mode === 'outbound-readonly' && !opts.outboundReadonlyApproved) {
      row.status = 'DISABLED_SCOPE_REQUIRED'
      row.reason = 'outbound-readonly requires operator approval'
      return row
    }

    // Custom healthcheck command.
    if (manifest.healthcheck?.command && this.deps.execute !== false) {
      const res = spawnSync(manifest.healthcheck.command[0], manifest.healthcheck.command.slice(1), {
        stdio: 'ignore',
      })
      if (res.status !== 0) {
        row.status = 'UNAVAILABLE'
        row.reason = `healthcheck command exit ${res.status}`
        return row
      }
    }

    // Service endpoint probe.
    if (
      manifest.runner.type === 'service' &&
      manifest.runner.endpoint &&
      opts.enableNetwork &&
      this.deps.execute !== false
    ) {
      const u = new URL(manifest.runner.endpoint)
      const lib = u.protocol === 'https:' ? httpsRequest : httpRequest
      const probe = new Promise<boolean>((resolve) => {
        const req = lib(
          { method: 'GET', hostname: u.hostname, port: u.port, path: '/' },
          (res) => {
            resolve(res.statusCode !== undefined && res.statusCode < 500)
            res.resume()
          },
        )
        req.on('error', () => resolve(false))
        req.setTimeout(2000, () => {
          req.destroy()
          resolve(false)
        })
        req.end()
      })
      try {
        const ok = await probe
        if (!ok) {
          row.status = 'UNAVAILABLE'
          row.reason = 'service endpoint failed probe'
          return row
        }
      } catch {
        row.status = 'UNAVAILABLE'
        row.reason = 'service endpoint unreachable'
        return row
      }
    }

    row.status = 'READY'
    return row
  }

  async checkAllAsync(opts: HealthOptions = {}): Promise<DoctorRow[]> {
    const rows: DoctorRow[] = []
    for (const m of this.deps.catalog.list()) {
      rows.push(await this.checkManifest(m, opts))
    }
    rows.sort((a, b) => a.manifestId.localeCompare(b.manifestId))
    return rows
  }

  /** Synchronous best-effort pass — skips network probes. */
  checkAll(opts: HealthOptions = {}): DoctorRow[] {
    const rows: DoctorRow[] = []
    for (const m of this.deps.catalog.list()) {
      rows.push(this.checkManifestSync(m))
    }
    rows.sort((a, b) => a.manifestId.localeCompare(b.manifestId))
    return rows
  }

  /** Synchronous variant that mirrors checkManifest but skips the network
   *  probe branch. Suitable for unit tests + bootstrap Doctor output. */
  checkManifestSync(manifest: OneShotManifest): DoctorRow {
    const row: DoctorRow = {
      category: manifest.category,
      manifestId: manifest.id,
      displayName: manifest.displayName,
      status: 'UNAVAILABLE',
    }

    if (manifest.maturity === 'experimental' && !manifest.enabledByDefault) {
      row.status = 'DEGRADED'
      row.reason = 'experimental + disabled by default'
      return row
    }

    if (
      manifest.scheduling.costTier === 'heavy' &&
      !manifest.enabledByDefault
    ) {
      // Heavy-tier manifests require explicit enable per §十四. The Doctor
      // surfaces this state so operators know the integration exists but
      // is gated.
      row.status = 'DISABLED_HEAVY'
      row.reason = 'heavy tier requires explicit enable'
      return row
    }

    // §P1 audit fix — sync variant applies the same digest / network
    // adapter / outbound-readonly gates as the async variant. Previously
    // checkAll() could wrongly report a container manifest as READY.
    if (manifest.runner.type === 'container' && manifest.maturity !== 'experimental') {
      if (!manifest.source.imageDigest) {
        row.status = 'DEGRADED'
        row.reason = 'image not pinned (imageDigest missing)'
        return row
      }
      if (!/^sha256:[a-f0-9]{64}$/.test(manifest.source.imageDigest)) {
        row.status = 'DEGRADED'
        row.reason = `imageDigest format invalid: ${manifest.source.imageDigest}`
        return row
      }
      if (manifest.runner.image && manifest.runner.image.endsWith(':latest')) {
        row.status = 'DEGRADED'
        row.reason = 'image uses :latest tag'
        return row
      }
    }

    if (
      manifest.network.mode === 'contest-target-only' &&
      !this.deps.networkAdapterPresent
    ) {
      row.status = 'DISABLED_SCOPE_REQUIRED'
      row.reason = 'contest-target-only requires configured network adapter'
      return row
    }
    if (
      manifest.network.mode === 'outbound-readonly' &&
      !this.deps.outboundReadonlyApproved
    ) {
      row.status = 'DISABLED_SCOPE_REQUIRED'
      row.reason = 'outbound-readonly requires operator approval'
      return row
    }

    if (
      manifest.network.mode !== 'none' &&
      manifest.network.requiresScopeApproval &&
      !manifest.enabledByDefault
    ) {
      row.status = 'DISABLED_SCOPE_REQUIRED'
      row.reason = 'network mode requires scope approval'
      return row
    }

    // §P1 audit fix — for `runner.type === 'process'`, verify the binary
    // exists on PATH before declaring READY. ENOENT / non-zero exit are
    // UNAVAILABLE with a specific reason. Same for container manifests.
    if (manifest.runner.type === 'process' && this.deps.execute !== false) {
      const head = manifest.runner.command?.[0]
      if (head) {
        const probe = spawnSync('sh', ['-c', `command -v ${JSON.stringify(head)} >/dev/null 2>&1`], { stdio: 'ignore' })
        if (probe.status !== 0) {
          row.status = 'UNAVAILABLE'
          row.reason = `binary missing: ${head}`
          return row
        }
      }
    }
    if (manifest.runner.type === 'container' && this.deps.execute !== false) {
      const probe = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { stdio: 'ignore' })
      if (probe.status !== 0) {
        row.status = 'UNAVAILABLE'
        row.reason = 'binary missing: docker'
        return row
      }
    }

    // Custom healthcheck command (sync). Production uses checkManifest (async).
    if (manifest.healthcheck?.command && this.deps.execute !== false) {
      const head = manifest.healthcheck.command[0]
      if (head) {
        const res = spawnSync(head, manifest.healthcheck.command.slice(1), {
          stdio: 'ignore',
        })
        if (res.status !== 0) {
          row.status = 'UNAVAILABLE'
          row.reason = `healthcheck command exit ${res.status}`
          return row
        }
      }
    }

    row.status = 'READY'
    return row
  }
}

/** Convenience: format doctor rows for CLI output (matches §十四 example). */
export function formatDoctor(rows: ReadonlyArray<DoctorRow>): string {
  const lines: string[] = []
  for (const r of rows) {
    lines.push(`${r.category}/${r.manifestId.padEnd(20)} ${r.status}`)
  }
  return lines.join('\n')
}

/** Status counts — used by tests and CLI exit-code. */
export function summarizeDoctor(rows: ReadonlyArray<DoctorRow>): Record<DoctorStatus, number> {
  const out: Record<DoctorStatus, number> = {
    READY: 0,
    DEGRADED: 0,
    DISABLED_HEAVY: 0,
    DISABLED_SCOPE_REQUIRED: 0,
    UNAVAILABLE: 0,
  }
  for (const r of rows) out[r.status]++
  return out
}
