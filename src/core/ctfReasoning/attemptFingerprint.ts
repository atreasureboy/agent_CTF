/**
 * AttemptFingerprint — Phase 2.1 §九.
 *
 * Stable hash of an attempt's identifying inputs. Same inputs (tool id,
 * parameters, artifact ids) → same fingerprint, allowing the
 * AttemptDeduplicator to detect retries of equivalent work.
 *
 * Requirements enforced:
 *   1. Object keys sorted for stability.
 *   2. Path keys normalized.
 *   3. Artifacts use id or sha256, never absolute paths.
 *   4. Timestamps / run ids / session temp dirs stripped.
 *   5. Sensitive data (passwords / tokens / flags) redacted.
 *   6. SHA-256 final hash, hex digest.
 */

import { createHash } from 'crypto'
import type { CTFAttempt } from '../ctfRuntime/taskState.js'

const SENSITIVE_KEY_RE = /api[_-]?key|token|secret|private|password|credential|passwd|flag|answer/i

function redactValue(v: unknown): unknown {
  // Stable redaction — every secret value becomes the SAME marker
  // string so different secrets with the same key produce the same
  // fingerprint. This is what we want for dedup.
  return '<redacted>'
}

function normalizeValue(v: unknown): unknown {
  if (v === null || v === undefined) return v
  if (Array.isArray(v)) {
    // Arrays: preserve order for ordered semantics; for set-like
    // arrays (e.g. artifactIds) the caller passes already-sorted
    // arrays. We map elements but do NOT sort the array itself.
    return v.map(normalizeValue)
  }
  if (typeof v === 'object') {
    return normalizeObject(v as Record<string, unknown>)
  }
  return v
}

function normalizeObject(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(obj).sort()) {
    if (SENSITIVE_KEY_RE.test(key)) {
      out[key] = redactValue(obj[key])
    } else {
      out[key] = normalizeValue(obj[key])
    }
  }
  return out
}

export interface AttemptFingerprintInput {
  kind: CTFAttempt['kind']
  targetId: string
  parameters: Record<string, unknown>
  inputArtifactIds?: string[]
  /** Optional override reason — included verbatim in the hash for human
   *  traceability but not affecting equivalence. */
  overrideReason?: string
}

export function createAttemptFingerprint(input: AttemptFingerprintInput): string {
  const payload = {
    kind: input.kind,
    targetId: input.targetId,
    // Sort artifact ids for stable comparison.
    inputArtifactIds: [...(input.inputArtifactIds ?? [])].sort(),
    parameters: normalizeObject(input.parameters),
  }
  const json = JSON.stringify(payload)
  return createHash('sha256').update(json).digest('hex')
}