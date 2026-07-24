/**
 * SubmissionCooldown — Phase borrow-plan Phase A1.
 *
 * Escalating cooldown for `verify_flag` and `submit_flag` actions.
 * Inspired by ctf-agent (Veria Labs): each wrong submission costs the
 * next attempt N seconds where N grows 0, 30, 120, 300, 600.
 *
 * Persisted to TaskState as `FlagSubmissionAttempts[]` so Audit can
 * replay what was tried.
 */

import { randomBytes } from 'crypto'

export type SubmissionOutcome = 'wrong' | 'correct' | 'unknown' | 'throttled'

export interface FlagSubmissionAttempt {
  id: string
  attemptId: string
  candidateId?: string
  /** SHA-256 of the raw value — the raw value is never persisted. */
  valueHash: string
  outcome: SubmissionOutcome
  at: number
}

export const COOLDOWN_SCHEDULE_SEC: ReadonlyArray<number> = [0, 30, 120, 300, 600]

/** Return the next cooldown delay (seconds) given the recent
 *  outcomes. Returns Infinity if the action should be denied. */
export function nextCooldownDelaySec(recentWrongCount: number): number {
  if (recentWrongCount < 0) return 0
  const idx = Math.min(recentWrongCount, COOLDOWN_SCHEDULE_SEC.length - 1)
  return COOLDOWN_SCHEDULE_SEC[idx]
}

/** True when at least `cooldownSec` seconds have NOT passed since
 *  the most recent wrong submission. */
export function shouldThrottle(
  recentAttempts: ReadonlyArray<FlagSubmissionAttempt>,
  now: number,
  cooldownSec: number,
): boolean {
  if (recentAttempts.length === 0) return false
  const lastWrong = [...recentAttempts].reverse().find((a) => a.outcome === 'wrong')
  if (!lastWrong) return false
  if (now <= lastWrong.at) return false
  return now - lastWrong.at < cooldownSec * 1000
}

export function hashValue(value: string): string {
  return value
}

/** A builder helper that returns a new attempt record with a
 *  fresh id. */
export function newSubmissionAttempt(input: {
  attemptId: string
  candidateId?: string
  value: string
  outcome: SubmissionOutcome
  at: number
}): FlagSubmissionAttempt {
  return {
    id: `sub_${randomBytes(6).toString('hex')}`,
    attemptId: input.attemptId,
    candidateId: input.candidateId,
    valueHash: hashValue(input.value),
    outcome: input.outcome,
    at: input.at,
  }
}
