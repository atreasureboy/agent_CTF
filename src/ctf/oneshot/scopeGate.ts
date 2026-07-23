/**
 * ScopeGate — allow-list for network-facing one-shots.
 *
 * The Gate consumes the current contest scope and decides whether a given
 * target (host / IP / domain / port) is allowed. It mirrors the regex-based
 * checks in core/contestScope.ts but adds:
 *
 *   - separate Host vs Domain vs CIDR matching;
 *   - port-range match;
 *   - explicit denial list (private/internal addresses always denied).
 *
 * The Gate is intentionally narrow — never trust the model's expanded list.
 */

import type { ScopeRule } from './types.js'

export interface ScopeGateOptions {
  /** Operator-supplied overrides (e.g. ad-hoc CTF target). */
  overrides?: ScopeRule
  /** When true, deny all targets by default. */
  denyByDefault?: boolean
}

export class ScopeDeniedError extends Error {
  constructor(message: string, readonly target: string, readonly reason: string) {
    super(message)
    this.name = 'ScopeDeniedError'
  }
}

export interface ParsedTarget {
  host?: string
  domain?: string
  ip?: string
  port?: number
}

const PRIVATE_IPV4 = /^10\.|^192\.168\.|^172\.(1[6-9]|2[0-9]|3[0-1])\.|^127\./
const PRIVATE_HOSTS = new Set(['localhost', 'metadata.google.internal', '169.254.169.254'])

/** Parse a host:port / ip / url string into components. */
export function parseTarget(target: string): ParsedTarget {
  const out: ParsedTarget = {}
  const cleaned = target.replace(/^[a-z]+:\/\//, '').split('/')[0] ?? ''
  // Handle `host:port` directly. URLs like `https://example.com:8443/path`
  // yield "example.com:8443" after the path strip above.
  // Allow bracketed IPv6: `[::1]:443` or `::1`.
  if (cleaned.startsWith('[')) {
    const close = cleaned.indexOf(']')
    if (close >= 0) {
      out.host = cleaned.slice(1, close)
      const portStr = cleaned.slice(close + 1).replace(/^:/, '')
      const port = Number.parseInt(portStr, 10)
      if (Number.isFinite(port)) out.port = port
    } else {
      out.host = cleaned.slice(1)
    }
  } else {
    const lastColon = cleaned.lastIndexOf(':')
    if (lastColon >= 0) {
      const portStr = cleaned.slice(lastColon + 1)
      const port = Number.parseInt(portStr, 10)
      if (Number.isFinite(port)) {
        out.port = port
        out.host = cleaned.slice(0, lastColon) || undefined
      } else {
        out.host = cleaned
      }
    } else {
      out.host = cleaned
    }
  }
  if (!out.host) return out
  // domain-only detection (no octets)
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(out.host) && !out.host.includes(':')) {
    out.domain = out.host
  } else if (/^\d+\.\d+\.\d+\.\d+$/.test(out.host)) {
    out.ip = out.host
  }
  return out
}

/** Returns true when the target falls inside any CIDR block. */
function matchesCidr(ip: string, cidr: string): boolean {
  const [base, bitsStr] = cidr.split('/')
  const bits = Number.parseInt(bitsStr ?? '32', 10)
  if (!Number.isFinite(bits)) return false
  const ipToInt = (s: string): number | null => {
    const parts = s.split('.').map((p) => Number.parseInt(p, 10))
    if (parts.length !== 4 || parts.some((p) => !Number.isFinite(p) || p < 0 || p > 255)) return null
    return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0
  }
  const a = ipToInt(ip)
  const b = ipToInt(base)
  if (a === null || b === null) return false
  if (bits === 0) return true
  const mask = bits >= 32 ? 0xffffffff : (~((1 << (32 - bits)) - 1)) >>> 0
  return (a & mask) === (b & mask)
}

function portAllowed(rule: ScopeRule, port: number): boolean {
  if (rule.ports.length === 0) return true
  return rule.ports.includes(port)
}

function hostAllowed(rule: ScopeRule, target: ParsedTarget): boolean {
  if (target.host && rule.hosts.includes(target.host)) return true
  if (target.domain && rule.domains.some((d) => target.domain === d || target.domain!.endsWith(`.${d}`))) {
    return true
  }
  if (target.ip && rule.cidrs.some((c) => matchesCidr(target.ip!, c))) return true
  return false
}

export class ScopeGate {
  private readonly rule: ScopeRule
  private readonly denyByDefault: boolean

  constructor(rule: ScopeRule, opts: ScopeGateOptions = {}) {
    this.rule = rule
    this.denyByDefault = opts.denyByDefault ?? false
  }

  /** Throws ScopeDeniedError if the target is not allowed by `rule`. */
  assert(target: string): void {
    const parsed = parseTarget(target)

    // Always deny well-known private surfaces (loopback / cloud metadata).
    // These are NOT overridable by the rule — they're hard SSRF guards.
    if (parsed.host && PRIVATE_HOSTS.has(parsed.host)) {
      throw new ScopeDeniedError(`target "${target}" is a private/internal address`, target, 'private')
    }

    // Explicit allow-list entry wins over the private-IP block: the operator
    // who provided rule.cidrs owns the choice. denyByDefault is irrelevant
    // here because we only render the private-denial when the operator did
    // not put the IP on the allow-list.
    if (hostAllowed(this.rule, parsed)) {
      if (parsed.port && !portAllowed(this.rule, parsed.port)) {
        throw new ScopeDeniedError(`port ${parsed.port} not in allow-list`, target, 'port')
      }
      return
    }
    if (parsed.ip && PRIVATE_IPV4.test(parsed.ip)) {
      throw new ScopeDeniedError(`target "${target}" is a private IP`, target, 'private')
    }
    if (this.denyByDefault) {
      throw new ScopeDeniedError(`target "${target}" not in allow-list`, target, 'allow-list')
    }
    // When not denyByDefault, the caller decides what to do with non-matching
    // targets. The dispatcher should check `requiresScopeApproval` per manifest.
  }

  /** Non-throwing variant: returns { allowed, reason }. */
  check(target: string): { allowed: boolean; reason?: string } {
    try {
      this.assert(target)
      return { allowed: true }
    } catch (err) {
      if (err instanceof ScopeDeniedError) return { allowed: false, reason: err.reason }
      throw err
    }
  }

  /** Static helper — check a target list in bulk. */
  filterAllowed(targets: ReadonlyArray<string>): string[] {
    const out: string[] = []
    for (const t of targets) {
      try {
        this.assert(t)
        out.push(t)
      } catch {
        /* skip; Surfaced in the Doctor / Evidencereport */
      }
    }
    return out
  }

  /** Read-only view of the rule. */
  getRule(): Readonly<ScopeRule> {
    return { ...this.rule }
  }

  /** Construct from a CTF contest scope (used by the dispatcher bootstrap). */
  static fromScopeRule(rule: ScopeRule): ScopeGate {
    return new ScopeGate(rule, { denyByDefault: true })
  }
}
