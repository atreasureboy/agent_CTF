/**
 * ContestScope — runtime gate for what counts as "in scope" for this CTF.
 *
 * Used by the Tool Broker to refuse network calls / filesystem reads outside
 * the contest's declared boundaries. Defaults to a conservative "no network,
 * files under cwd only" posture so the harness is safe-by-default.
 */

import { resolve, sep } from 'path'
import { z } from 'zod'

export const contestScopeSchema = z
  .object({
    allowedHosts: z.array(z.string()).optional(),
    allowedCidrs: z.array(z.string()).optional(),
    allowedPorts: z.array(z.number().int().min(0).max(65535)).optional(),
    allowedDomains: z.array(z.string()).optional(),
    allowedFilesRoot: z.string().min(1),
    allowPublicNetwork: z.boolean().default(false),
  })
  .strict()

export type ContestScope = z.output<typeof contestScopeSchema>
export type ContestScopeInput = z.input<typeof contestScopeSchema>

export function parseContestScope(raw: unknown): ContestScope {
  return contestScopeSchema.parse(raw)
}

/** Safe-parse with a fallback (used for ad-hoc CLI overrides). */
export function safeParseContestScope(
  raw: unknown,
  fallback: ContestScope,
): ContestScope {
  const r = contestScopeSchema.safeParse(raw)
  return r.success ? r.data : fallback
}

/**
 * Minimal CIDR check — covers /8, /16, /24, /32 ipv4. Sufficient for CTF
 * scope gating; consumers needing full RFC 4632 should swap in a library.
 */
function ipv4InCidr(ip: string, cidr: string): boolean {
  const [base, prefixStr] = cidr.split('/')
  const prefix = Number(prefixStr ?? '32')
  if (!Number.isFinite(prefix) || prefix < 0 || prefix > 32) return false
  const ipParts = ip.split('.')
  const baseParts = base.split('.')
  if (ipParts.length !== 4 || baseParts.length !== 4) return false

  const toInt = (parts: string[]): number =>
    parts.reduce(
      (acc, p) => (acc << 8) + (Number.isFinite(Number(p)) ? Number(p) : 256),
      0,
    ) >>> 0

  if (Number.isNaN(toInt(ipParts)) || Number.isNaN(toInt(baseParts))) return false
  const ipInt = toInt(ipParts)
  const baseInt = toInt(baseParts)
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0
  return (ipInt & mask) === (baseInt & mask)
}

export class ContestScopeChecker {
  private readonly scope: ContestScope

  constructor(scope: ContestScope) {
    this.scope = scope
  }

  /** Strip brackets and split host:port. Returns null for unparseable. */
  private static splitHostPort(target: string): { host: string; port?: number } | null {
    const m = target.match(/^(\[?[\w.:-]+\]?)(?::(\d+))?$/)
    if (!m) return null
    let host = m[1]
    if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
    const port = m[2] ? Number(m[2]) : undefined
    return { host, port }
  }

  isHostAllowed(host: string): boolean {
    if (this.scope.allowedHosts?.includes(host)) return true
    if (this.scope.allowedCidrs?.some((c) => ipv4InCidr(host, c))) return true
    if (this.scope.allowedDomains?.some((d) => host === d || host.endsWith(`.${d}`))) {
      return true
    }
    return false
  }

  isPortAllowed(port: number | undefined): boolean {
    if (port === undefined) return true
    if (!this.scope.allowedPorts || this.scope.allowedPorts.length === 0) return true
    return this.scope.allowedPorts.includes(port)
  }

  isNetworkAllowed(target: string): boolean {
    if (this.scope.allowPublicNetwork) return true
    const parsed = ContestScopeChecker.splitHostPort(target)
    if (!parsed) return false
    return this.isHostAllowed(parsed.host) && this.isPortAllowed(parsed.port)
  }

  isFileAllowed(path: string): boolean {
    const root = resolve(this.scope.allowedFilesRoot)
    const abs = resolve(path)
    if (abs === root) return true
    if (!abs.startsWith(root + sep) && !abs.startsWith(root)) return false
    return true
  }

  /** Throws with a structured error so the Broker can surface to the model. */
  assertFile(path: string): void {
    if (!this.isFileAllowed(path)) {
      throw new ScopeViolationError(
        `Path "${path}" is outside the contest's allowedFilesRoot (${this.scope.allowedFilesRoot}).`,
        'file',
      )
    }
  }

  /** Throws when target host:port is out of scope. */
  assertNetwork(target: string): void {
    if (!this.isNetworkAllowed(target)) {
      throw new ScopeViolationError(
        `Network target "${target}" is outside the contest's network scope.`,
        'network',
      )
    }
  }
}

export class ScopeViolationError extends Error {
  readonly kind: 'file' | 'network'
  constructor(message: string, kind: 'file' | 'network') {
    super(message)
    this.name = 'ScopeViolationError'
    this.kind = kind
  }
}
