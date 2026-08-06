/**
 * FlagExtractionPipeline — multi-pass flag extraction for competition solving.
 *
 * Replaces the fragile single-path approach (scan findings for
 * `category === 'flag'` or `title.includes('flag')`) with 4 layered
 * passes + SHA256 verification.
 *
 * Passes (in order of reliability):
 *   1. stdout regex — broad pattern matching on agent output
 *   2. Flag candidates — structured candidates from TaskState
 *   3. Findings scan — finding summaries/evidence
 *   4. Artifact content scan — raw artifact text
 *
 * The highest-confidence candidate wins. When `expectedFlagSha256` is
 * provided, candidates are verified deterministically.
 */

import type {
  CTFTaskState,
  FlagCandidate,
  OneShotRunRecord,
} from '../../core/ctfRuntime/taskState.js'
import type { OneShotResult } from '../oneshot/types.js'
import { createHash } from 'crypto'

// ── Types ─────────────────────────────────────────────────────────────────

export interface ExtractionAttempt {
  value: string
  source: 'stdout_regex' | 'flag_candidate' | 'findings_scan' | 'artifact_scan' | 'oneshot_result'
  confidence: number
  verified: boolean
  verificationMethod?: 'sha256' | 'pattern' | 'none'
}

export interface ExtractionResult {
  /** Best candidate (highest confidence), or undefined. */
  best: ExtractionAttempt | undefined
  /** All candidates found, deduplicated by value. */
  all: ExtractionAttempt[]
  /** SHA256 hash of the best candidate (if any). */
  bestHash: string | undefined
}

// ── Flag regex patterns ───────────────────────────────────────────────────

/**
 * Broad flag patterns covering common CTF formats.
 * §Round-3 — expanded from the original solve.ts patterns.
 */
const FLAG_PATTERNS: RegExp[] = [
  // Standard format
  /[A-Za-z0-9_-]+{[^}\s]{4,}}/g,
  // picoCTF
  /picoCTF\{[^}\s]+\}/gi,
  // flag(...) format
  /flag\([^)\s]{4,}\)/gi,
  // FLAG[...] format
  /flag\[[^\]\s]{4,}\]/gi,
  // Bare {flag-like} in known contexts
  /"([A-Za-z0-9_\-+=/!?@#$%^&*()]{4,})"/g,
]

/** Patterns that indicate a placeholder, not a real flag. */
const PLACEHOLDER_PATTERNS = [
  /\.{3,}/, // ellipsis ...
  /x{3,}/i, // xxx placeholder
  /<flag>/i, // literal <flag>
  /your.?flag/i, // "your flag here"
  /example/i, // example flag
  /replace/i, // "replace this"
]

// ── Pipeline ──────────────────────────────────────────────────────────────

export class FlagExtractionPipeline {
  /**
   * Extract flag candidates from all available sources.
   *
   * @param state  Full TaskState after agent/oneshot execution
   * @param stdout Raw stdout text (if available, e.g. solve.ts path)
   * @param expectedFlagSha256  If provided, verify candidates against this hash
   * @param oneShotResults  Pre-loaded oneshot results (optional, avoids IO)
   */
  extract(
    state: CTFTaskState,
    stdout?: string,
    expectedFlagSha256?: string,
    oneShotResults?: OneShotResult[],
  ): ExtractionResult {
    const attempts: ExtractionAttempt[] = []

    // Pass 1: stdout regex (broad, fast)
    if (stdout && stdout.length > 0) {
      attempts.push(...this.extractFromStdout(stdout))
    }

    // Pass 2: structured flag candidates (highest quality if validated)
    attempts.push(...this.extractFromCandidates(state))

    // Pass 3: findings scan
    attempts.push(...this.extractFromFindings(state))

    // Pass 4: artifact hints from oneshot results
    if (oneShotResults && oneShotResults.length > 0) {
      attempts.push(...this.extractFromOneShotResults(oneShotResults))
    }

    // SHA256 verification
    if (expectedFlagSha256) {
      for (const a of attempts) {
        a.verified = this.verifySha256(a.value, expectedFlagSha256)
        a.verificationMethod = a.verified ? 'sha256' : 'none'
        if (a.verified) {
          a.confidence = 1.0
        }
      }
    }

    // Deduplicate & rank
    const deduped = this.deduplicateAndRank(attempts)

    return {
      best: deduped[0],
      all: deduped,
      bestHash: deduped[0] ? this.sha256(deduped[0].value) : undefined,
    }
  }

  // ── Passes ───────────────────────────────────────────────────────────

  private extractFromStdout(stdout: string): ExtractionAttempt[] {
    const attempts: ExtractionAttempt[] = []
    for (const pattern of FLAG_PATTERNS) {
      const matches = stdout.matchAll(pattern)
      for (const m of matches) {
        const value = m[0].replace(/^"|"$/g, '').trim()
        if (!value || this.isPlaceholder(value)) continue
        attempts.push({
          value,
          source: 'stdout_regex',
          confidence: 0.75,
          verified: false,
          verificationMethod: 'none',
        })
      }
    }
    // Also check for bare flag-like strings in lines containing 'flag'
    const lines = stdout.split('\n')
    for (const line of lines) {
      if (!/flag/i.test(line)) continue
      const bareMatch = line.match(/([A-Za-z0-9_\-+=/!?@#$%^&*()]{8,})/)
      if (bareMatch && !this.isPlaceholder(bareMatch[1])) {
        attempts.push({
          value: bareMatch[1],
          source: 'stdout_regex',
          confidence: 0.55,
          verified: false,
          verificationMethod: 'none',
        })
      }
    }
    return attempts
  }

  private extractFromCandidates(state: CTFTaskState): ExtractionAttempt[] {
    const candidates: FlagCandidate[] = state.flagCandidates ?? []
    return candidates
      .filter((c) => c.status !== 'rejected' && !this.isPlaceholder(c.value))
      .map((c) => ({
        value: c.value,
        source: 'flag_candidate' as const,
        confidence: this.candidateConfidence(c),
        verified: c.status === 'validated' || c.status === 'accepted',
        verificationMethod: c.matchedPattern ? 'pattern' : 'none',
      }))
  }

  private extractFromFindings(state: CTFTaskState): ExtractionAttempt[] {
    const findings = state.findings ?? []
    const attempts: ExtractionAttempt[] = []

    for (const f of findings) {
      // Check finding titles
      const titleFlag = this.extractFlagFromText(String(f.title ?? ''))
      if (titleFlag) {
        attempts.push({
          value: titleFlag,
          source: 'findings_scan',
          confidence: 0.8,
          verified: false,
          verificationMethod: 'none',
        })
      }

      // Check finding summaries via category field
      const cat = String(f.category ?? '').toLowerCase()
      if (cat === 'flag') {
        // Finding with category='flag' likely has the flag in its summary or a flagValue field
        // eslint-disable-next-line @typescript-eslint/no-base-to-string
        const summaryText = String((f as unknown as Record<string, unknown>).summary ?? '')
        const flagMatch = this.extractFlagFromText(summaryText)
        if (flagMatch) {
          attempts.push({
            value: flagMatch,
            source: 'findings_scan',
            confidence: 0.85,
            verified: false,
            verificationMethod: 'none',
          })
        }
        const flagValue = (f as unknown as Record<string, unknown>).flagValue as string | undefined
        if (flagValue && !this.isPlaceholder(flagValue)) {
          attempts.push({
            value: flagValue,
            source: 'findings_scan',
            confidence: 0.9,
            verified: false,
            verificationMethod: 'none',
          })
        }
      }
    }

    // Also check oneShotRunRecords for flagCandidateIds that resolve to state
    const oneShotRuns: OneShotRunRecord[] = state.oneShotRuns ?? []
    for (const run of oneShotRuns) {
      for (const candidateId of run.flagCandidateIds ?? []) {
        const candidate = state.flagCandidates?.find((c) => c.id === candidateId)
        if (candidate && candidate.status !== 'rejected') {
          attempts.push({
            value: candidate.value,
            source: 'findings_scan',
            confidence: this.candidateConfidence(candidate),
            verified: candidate.matchedPattern,
            verificationMethod: candidate.matchedPattern ? 'pattern' : 'none',
          })
        }
      }
    }

    return attempts
  }

  private extractFromOneShotResults(results: OneShotResult[]): ExtractionAttempt[] {
    const attempts: ExtractionAttempt[] = []
    for (const r of results) {
      for (const c of r.candidates) {
        if (!this.isPlaceholder(c.value)) {
          attempts.push({
            value: c.value,
            source: 'oneshot_result',
            confidence: c.confidence,
            verified: false,
            verificationMethod: 'none',
          })
        }
      }
      // Also scan finding summaries from oneshot
      for (const f of r.findings) {
        const flagMatch = this.extractFlagFromText(f.summary)
        if (flagMatch) {
          attempts.push({
            value: flagMatch,
            source: 'oneshot_result',
            confidence: f.confidence === 'high' ? 0.8 : f.confidence === 'medium' ? 0.6 : 0.4,
            verified: false,
            verificationMethod: 'none',
          })
        }
      }
    }
    return attempts
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  private extractFlagFromText(text: string): string | undefined {
    for (const pattern of FLAG_PATTERNS) {
      const m = text.match(pattern)
      if (m && !this.isPlaceholder(m[0])) {
        return m[0].trim()
      }
    }
    // Fallback: any non-whitespace sequence after 'flag' keyword
    const bareMatch = text.match(/flag[:\s=]+(\S{8,})/i)
    if (bareMatch && !this.isPlaceholder(bareMatch[1])) {
      return bareMatch[1]
    }
    return undefined
  }

  private isPlaceholder(value: string): boolean {
    if (!value || value.length < 4) return true
    for (const p of PLACEHOLDER_PATTERNS) {
      if (p.test(value)) return true
    }
    return false
  }

  private candidateConfidence(c: FlagCandidate): number {
    if (c.status === 'accepted') return 1.0
    if (c.status === 'validated') return 0.99
    if (c.status === 'submitted') return 0.95
    if (c.matchedPattern) return 0.85
    return c.confidence > 0 ? c.confidence : 0.5
  }

  /**
   * Deduplicate by value (case-insensitive) and rank by confidence descending.
   * The same flag value may appear from multiple sources — keep the highest-
   * confidence record.
   */
  private deduplicateAndRank(attempts: ExtractionAttempt[]): ExtractionAttempt[] {
    const seen = new Map<string, ExtractionAttempt>()
    for (const a of attempts) {
      const key = a.value.toLowerCase().trim()
      const existing = seen.get(key)
      if (!existing || a.confidence > existing.confidence) {
        seen.set(key, a)
      }
    }
    return [...seen.values()].sort((a, b) => b.confidence - a.confidence)
  }

  // ── Verification ─────────────────────────────────────────────────────

  sha256(value: string): string {
    return createHash('sha256').update(value).digest('hex')
  }

  verifySha256(value: string, expectedHash: string): boolean {
    try {
      return this.sha256(value) === expectedHash
    } catch {
      return false
    }
  }
}

/** Shared singleton instance. */
export const flagExtractionPipeline = new FlagExtractionPipeline()
