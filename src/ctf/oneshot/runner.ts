/**
 * Runner interface + a single production-grade factory that returns the
 * appropriate implementation per manifest. Tests inject the field directly
 * via `setRunnerOverride`.
 */

import type { OneShotManifest, OneShotResult } from './types.js'
import { ProcessRunner } from './processRunner.js'
import { ContainerRunner } from './containerRunner.js'
import { ServiceRunner } from './serviceRunner.js'

export interface RunnerInputs {
  /** Where stdout/stderr streams are written. */
  logDir: string
  /** Manifest `argv` substituted with concrete arguments (paths / params). */
  argv: string[]
  /** Manifest-provided env overrides. */
  env?: Record<string, string>
  /** Filesystem mounts / workspace dir for the runner (read-only for containers). */
  workspace: string
  /** AbortSignal to propagate the parent task's cancel. */
  signal: AbortSignal
}

export interface OneShotRunner {
  /** Run manifest, returning the structured OneShotResult. */
  run(manifest: OneShotManifest, inputs: RunnerInputs): Promise<OneShotResult>
  /** Cancel any in-flight execution (best-effort). */
  cancel?(runId: string): Promise<void>
}

/**
 * Default factory: returns the runner matching manifest.runner.type. Tests
 * can override individual fields via `setRunnerOverride`.
 */
const overrides = new Map<string, OneShotRunner>()

export function runnerFor(manifest: OneShotManifest): OneShotRunner {
  const ovr = overrides.get(manifest.id)
  if (ovr) return ovr
  switch (manifest.runner.type) {
    case 'process':
      return new ProcessRunner()
    case 'container':
      return new ContainerRunner()
    case 'service':
      return new ServiceRunner()
  }
}

export function setRunnerOverride(manifestId: string, runner: OneShotRunner): void {
  overrides.set(manifestId, runner)
}

export function clearRunnerOverrides(): void {
  overrides.clear()
}
