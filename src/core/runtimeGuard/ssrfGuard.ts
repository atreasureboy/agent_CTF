/**
 * SSRFGuard — Phase borrow-plan Phase A2.
 *
 * Inspired by CAI's `fetch_url` which defaults to blocking loopback,
 * RFC1918, link-local, and metadata IPs. We do the same.
 *
 * Per-instance CIDR allowlist is configurable via env
 * (`AGENT_CTF_FETCH_ALLOW_INTERNAL=1`) for testing.
 */

import { lookup } from 'dns/promises'

type LookupAddress = { address: string; family: number }

const BLOCKED_CIDRS_V4: ReadonlyArray<[string, number]> = [
  ['0.0.0.0', 8], // current network
  ['10.0.0.0', 8], // RFC1918 private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local (incl. AWS IMDS 169.254.169.254)
  ['172.16.0.0', 12], // RFC1918 private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.168.0.0', 16], // RFC1918 private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved
  ['255.255.255.255', 32], // broadcast
]

export interface SsrfGuardResult {
  allowed: boolean
  reason?: string
  resolvedIp?: string
}

function ipv4ToInt(ip: string): number | null {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip)
  if (!m) return null
  const o = [m[1], m[2], m[3], m[4]].map(Number)
  if (o.some((n) => n < 0 || n > 255)) return null
  return ((o[0]! << 24) | (o[1]! << 16) | (o[2]! << 8) | o[3]!) >>> 0
}

function isBlockedV4(ip: string): boolean {
  const n = ipv4ToInt(ip)
  if (n === null) return true
  for (const [base, prefix] of BLOCKED_CIDRS_V4) {
    const b = ipv4ToInt(base)
    if (b === null) continue
    const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0
    if ((n & mask) === (b & mask)) return true
  }
  return false
}

/** Public API: validate a URL. Returns `{ allowed, reason?, resolvedIp? }`.
 *  When allowed is false, the runner MUST NOT fetch the URL. */
export async function validateUrl(url: string): Promise<SsrfGuardResult> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { allowed: false, reason: 'malformed_url' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { allowed: false, reason: 'unsupported_protocol' }
  }
  if (process.env['AGENT_CTF_FETCH_ALLOW_INTERNAL'] === '1') {
    return { allowed: true, resolvedIp: 'allowlisted' }
  }
  let addresses: LookupAddress[]
  try {
    addresses = await lookup(parsed.hostname, { all: true })
  } catch {
    return { allowed: false, reason: 'dns_resolution_failed' }
  }
  for (const a of addresses) {
    if (a.family === 4 && isBlockedV4(a.address)) {
      return { allowed: false, reason: 'blocked_cidr', resolvedIp: a.address }
    }
    // IPv6 — block loopback / link-local / unique-local.
    if (a.family === 6) {
      const lower = a.address.toLowerCase()
      if (
        lower === '::1' ||
        lower.startsWith('fe80:') ||
        lower.startsWith('fc') ||
        lower.startsWith('fd')
      ) {
        return { allowed: false, reason: 'blocked_ipv6_scope', resolvedIp: a.address }
      }
    }
  }
  return { allowed: true, resolvedIp: addresses[0]?.address }
}
