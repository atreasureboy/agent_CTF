/**
 * Shotgun Profile — CapabilityProfile for the Shotgun Agent.
 *
 * Per six_goal §四 the Shotgun Agent is a *coordinator*, not a solver:
 *   - it owns NO solving tools (Bash, Python, exploit primitives);
 *   - it owns ONLY the four OneShot meta-tools + status reading tools;
 *   - it cannot submit flags;
 *   - it cannot read contest credentials.
 *
 * This file ships the static profile; runtime code wires it like any other
 * capability profile (registry register, Broker consume).
 */

import { parseCapabilityProfile, type CapabilityProfile } from '../../core/capabilityProfile.js'

export const SHOTGUN_PROFILE_RAW = {
  id: 'shotgun-runner',
  displayName: 'Shotgun Coordinator',
  description:
    'Coordinates background one-shot tool runs (Ciphey, RsaCtfTool, capa, etc.) ' +
    'and selects which manifests to run for a given task. Never solves, never submits.',
  allowedTools: ['run_one_shot', 'list_one_shots', 'inspect_one_shot_result', 'cancel_one_shot'],
  deniedTools: [
    'Bash',
    'Write',
    'Edit',
    'extract_artifact',
    'request_handoff', // Shotgun does not delegate further; it returns results to the requesting Specialist.
  ],
  allowShell: false,
  allowPython: false,
  allowBackgroundJobs: true,
  allowAgentHandoff: false,
  preferredAgentsForHandoff: [],
  maturity: 'stable' as const,
  enabledByDefault: false, // Only spawned by Specialists on demand.
  limits: {
    maxIterations: 10,
    maxParallelJobs: 4,
    maxExecutionSeconds: 600,
    maxToolCalls: 30,
  },
  // No `runner` field — this profile never spawns one-shots directly.
  // Shotgun calls the OneShot meta-tools which route through the dispatcher.
} as unknown

let _cached: CapabilityProfile | null = null

export function getShotgunProfile(): CapabilityProfile {
  if (!_cached) _cached = parseCapabilityProfile(SHOTGUN_PROFILE_RAW)
  return _cached
}
