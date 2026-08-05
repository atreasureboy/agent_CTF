/**
 * FlagCandidate draft — Phase 2.1 §二十八.
 *
 * The Materializer produces drafts; the Orchestrator promotes them to
 * `FLAG_CANDIDATE_DETECTED` events. The Validator promotes to
 * `validated` only when pattern + provenance + local verify all pass.
 */

import { randomBytes } from 'crypto'

export interface FlagCandidateDraft {
  value: string
  normalizedValue: string
  sourceObservationIds: string[]
  sourceEvidenceIds: string[]
  sourceArtifactIds: string[]
  sourceRunIds: string[]
  transformChain?: Array<{ operation: string; inputHash: string; outputHash: string }>
  confidence: number
  producer: {
    type: 'parser' | 'workflow' | 'oneshot' | 'agent' | 'specialist' | 'manual'
    id: string
  }
}

export function buildFlagCandidateId(): string {
  return `fc_${randomBytes(6).toString('hex')}`
}

/** Normalize a candidate value: trim whitespace, collapse case for
 *  ASCII letters, drop zero-width chars. */
export function normalizeFlagValue(v: string): string {
  // eslint-disable-next-line
  return v.replace(/[​‌‍﻿]/g, '').trim()
}

export const DEFAULT_FLAG_PATTERNS: RegExp[] = [
  /flag\{[^}]+\}/i,
  /CTF\{[^}]+\}/i,
  /FLAG\{[^}]+\}/i,
  /DASCTF\{[^}]+\}/i,
  /XHLJ\{[^}]+\}/i,
  /西湖论剑\{[^}]+\}/i,
  /HECTF\{[^}]+\}/i,
  /NCTF\{[^}]+\}/i,
  /WMCTF\{[^}]+\}/i,
  /CISCN\{[^}]+\}/i,
  /key\{[^}]+\}/i,
  /secret\{[^}]+\}/i,
  /password\{[^}]+\}/i,
  /pwn\{[^}]+\}/i,
  /shell\{[^}]+\}/i,
  /admin\{[^}]+\}/i,
  /hgame\{[^}]+\}/i,
  /0xGame\{[^}]+\}/i,
  /GKCTF\{[^}]+\}/i,
  /MRCTF\{[^}]+\}/i,
  /HSCTF\{[^}]+\}/i,
  // Generic prefix{...} pattern — requires minimum 8 chars inside braces
  /[A-Za-z0-9_]+\{[^}]{8,}\}/,
]

/** Detect a flag-like value in a piece of text. */
export function detectFlagLike(text: string): string | null {
  if (!text) return null
  for (const p of DEFAULT_FLAG_PATTERNS) {
    const m = p.exec(text)
    if (m) return m[0]
  }
  return null
}

/** Detect ALL flag-like values in text. Useful for bulk extraction. */
export function detectAllFlags(text: string): string[] {
  if (!text) return []
  const found = new Set<string>()
  for (const p of DEFAULT_FLAG_PATTERNS) {
    const re = new RegExp(p.source, p.flags.includes('g') ? p.flags : p.flags + 'g')
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      found.add(m[0])
    }
  }
  return [...found]
}
