/**
 * CompletionPolicy — Phase 2.2 §二十三.
 *
 * Controls whether a validated Flag Candidate automatically completes the
 * task. Two switches:
 *
 *   - autoCompleteLocalFixtures: when true, locally validated candidates
 *     close the task with status='solved'. Useful for fixtures, replays,
 *     and CI smoke tests.
 *
 *   - requirePlatformVerification: when true, the task waits for human or
 *     platform confirmation before marking 'solved'. Default true for
 *     real contests (we do not auto-submit on a CTF server).
 */

export interface CompletionPolicy {
  autoCompleteLocalFixtures: boolean
  requirePlatformVerification: boolean
}

export const DEFAULT_COMPLETION_POLICY: CompletionPolicy = {
  autoCompleteLocalFixtures: false,
  requirePlatformVerification: true,
}

export const LOCAL_FIXTURE_COMPLETION_POLICY: CompletionPolicy = {
  autoCompleteLocalFixtures: true,
  requirePlatformVerification: false,
}