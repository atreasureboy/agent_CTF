/**
 * AttemptDeduplicator — Phase 2.1 §十.
 *
 * Decides whether a candidate Attempt is allowed to run given the
 * current TaskState. Same fingerprint + same outcome → blocked.
 *
 * Rules:
 *   - Succeeded attempt with the same fingerprint → blocked.
 *   - Running attempt with the same fingerprint → blocked (no
 *     concurrent duplicates).
 *   - Failed attempt with the same fingerprint AND unchanged inputs →
 *     blocked (no immediate retry).
 *   - `overrideReason` permits an otherwise-blocked attempt and is
 *     recorded in the candidate's record (Planner cannot fake it).
 *   - Tool-internal retry does NOT create a new Attempt; the existing
 *     attempt is updated with an `AttemptExecution` record.
 */

import { createAttemptFingerprint } from './attemptFingerprint.js'
import type { CTFAttempt } from '../ctfRuntime/taskState.js'

export interface AttemptCandidate {
  kind: CTFAttempt['kind']
  targetId: string
  input: Record<string, unknown>
  inputArtifactIds?: string[]
  hypothesisIds?: string[]
  overrideReason?: string
}

export interface AttemptDeduplicationDecision {
  allowed: boolean
  fingerprint: string
  reason?: 'already_succeeded' | 'already_running' | 'immediate_retry' | 'override'
  existingAttemptId?: string
  overrideRecorded?: boolean
}

export interface AttemptDeduplicator {
  check(
    candidate: AttemptCandidate,
    state: Readonly<{ attempts: CTFAttempt[] }>,
  ): AttemptDeduplicationDecision
}

export function createAttemptDeduplicator(): AttemptDeduplicator {
  return {
    check(candidate, state) {
      const fingerprint = createAttemptFingerprint({
        kind: candidate.kind,
        targetId: candidate.targetId,
        parameters: candidate.input,
        inputArtifactIds: candidate.inputArtifactIds,
        overrideReason: candidate.overrideReason,
      })

      const existing = state.attempts.find((a) => a.fingerprint === fingerprint)
      if (!existing) {
        return { allowed: true, fingerprint }
      }
      if (candidate.overrideReason) {
        return {
          allowed: true,
          fingerprint,
          reason: 'override',
          existingAttemptId: existing.id,
          overrideRecorded: true,
        }
      }
      if (existing.status === 'succeeded') {
        return {
          allowed: false,
          fingerprint,
          reason: 'already_succeeded',
          existingAttemptId: existing.id,
        }
      }
      if (existing.status === 'running' || existing.status === 'pending') {
        return {
          allowed: false,
          fingerprint,
          reason: 'already_running',
          existingAttemptId: existing.id,
        }
      }
      // failed / cancelled → block immediate retry unless inputs changed
      // (we treat any different input as a different attempt; this dedup is
      // conservative).
      return {
        allowed: false,
        fingerprint,
        reason: 'immediate_retry',
        existingAttemptId: existing.id,
      }
    },
  }
}
