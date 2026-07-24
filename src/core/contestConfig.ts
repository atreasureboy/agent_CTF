/**
 * .ovogo/contest.json loader — declarative ContestScope configuration.
 *
 * In the 9th Xihu Lunjian CTF, the contest platform pushes a JSON config to
 * each team describing the network/file boundaries for the day's challenges.
 * This loader is the harness-side counterpart:
 *
 *   - Reads `.ovogo/contest.json` from the project root (or cwd).
 *   - Validates against `contestScopeSchema` (or a richer superset).
 *   - Merges with CLI overrides (highest precedence).
 *   - Returns a fully-resolved `ContestScope` ready for `ContestScopeChecker`.
 *
 * CLI overrides win over the file. The file wins over the harness defaults.
 *
 * Why a separate file rather than env vars?
 *   - Configurable scope per task / per contest day
 *   - Auditable in the .ovogo/ directory (visible to judges during code review)
 *   - Survives across `ovogogogo-ctf` invocations
 *
 * File shape:
 * ```json
 * {
 *   "allowedHosts":     ["10.0.0.0/24", "ctf.example.com"],
 *   "allowedDomains":   ["example.com", "ctf.local"],
 *   "allowedCidrs":     ["10.0.0.0/8"],
 *   "allowedPorts":     [80, 443, 8080],
 *   "allowedFilesRoot": "/srv/ctf",
 *   "allowPublicNetwork": false,
 *   "maxTaskDurationMs": 3600000,
 *   "notes": "Round 1 — strict egress"
 * }
 * ```
 *
 * Optional keys fall back to safe defaults.
 */

import { existsSync, readFileSync } from 'fs'
import { resolve, join } from 'path'

import { contestScopeSchema, parseContestScope } from './contestScope.js'
import { z } from 'zod'
import type { ContestScope } from './contestScope.js'

export const contestConfigSchema = contestScopeSchema.extend({
  /** Free-form notes for the team / judges (round, theme, restrictions). */
  notes: z.string().optional(),
  /** Maximum wall-clock per task in ms (advisory — orchestrator enforces). */
  maxTaskDurationMs: z.number().int().positive().optional(),
})

export type ContestConfig = z.output<typeof contestConfigSchema>
export type ContestConfigInput = z.input<typeof contestConfigSchema>

/** Default search paths, in priority order. */
export const CONTEST_CONFIG_PATHS = [
  '.ovogo/contest.json',
  '.ovogo/contest.config.json',
  'ovogo.contest.json',
] as const

export interface LoadContestConfigOptions {
  /** Project root to search under. Defaults to process.cwd(). */
  cwd?: string
  /** Optional explicit path; bypasses search. */
  explicitPath?: string
}

export interface LoadContestConfigResult {
  /** The path that was actually read, or null if no file was found. */
  sourcePath: string | null
  /** Parsed + validated ContestConfig. */
  config: ContestConfig
  /** True when a config file was found and used. */
  loaded: boolean
}

/**
 * Search the project's `.ovogo/` directory for a contest config and return a
 * validated ContestConfig. Missing file is not an error — the harness falls
 * back to safe defaults so an empty repo can still run.
 */
export function loadContestConfig(opts: LoadContestConfigOptions = {}): LoadContestConfigResult {
  const cwd = opts.cwd ?? process.cwd()
  const candidate = opts.explicitPath ? resolve(opts.explicitPath) : pickExisting(cwd)
  if (!candidate) {
    return {
      sourcePath: null,
      config: createDefaultContestConfig({ cwd }),
      loaded: false,
    }
  }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(candidate, 'utf8'))
  } catch (err) {
    throw new Error(`Failed to parse ${candidate}: ${(err as Error).message}`)
  }
  const parsed = contestConfigSchema.parse(raw)
  return { sourcePath: candidate, config: parsed, loaded: true }
}

function pickExisting(cwd: string): string | null {
  for (const rel of CONTEST_CONFIG_PATHS) {
    const abs = join(cwd, rel)
    if (existsSync(abs)) return abs
  }
  return null
}

/**
 * Merge CLI overrides on top of a file-derived config. CLI wins.
 */
export function mergeContestConfig(
  base: ContestConfig,
  override: Partial<ContestConfig> | undefined,
): ContestConfig {
  if (!override) return base
  return contestConfigSchema.parse({
    ...base,
    ...override,
    // Arrays in CLI overrides REPLACE the file's arrays (predictable for ops).
    allowedHosts: override.allowedHosts ?? base.allowedHosts,
    allowedDomains: override.allowedDomains ?? base.allowedDomains,
    allowedCidrs: override.allowedCidrs ?? base.allowedCidrs,
    allowedPorts: override.allowedPorts ?? base.allowedPorts,
  })
}

/**
 * One-shot helper used by the CLI / harness factory: load + merge in a single
 * call.
 */
export function resolveContestConfig(
  opts: LoadContestConfigOptions & {
    cliOverride?: Partial<ContestConfig>
    cwd?: string
  } = {},
): { scope: ContestScope; config: ContestConfig; sourcePath: string | null } {
  const result = loadContestConfig({ cwd: opts.cwd, explicitPath: opts.explicitPath })
  const merged = mergeContestConfig(result.config, opts.cliOverride)
  return { scope: merged, config: merged, sourcePath: result.sourcePath }
}

/**
 * The single authoritative default ContestConfig. ALL entry points
 * (CLI, Harness, Orchestrator, tests) must call this when no config was
 * supplied. The defaults are conservative:
 *
 *   - allowPublicNetwork = false   (no egress unless explicitly granted)
 *   - allowedFilesRoot  = cwd      (workspace-only reads/writes)
 *
 * Callers that need to broaden the scope must pass the broadened config to
 * `mergeContestConfig()` rather than constructing a fresh `ContestConfig`
 * literal — this guarantees one source of truth.
 */
export function createDefaultContestConfig(opts: { cwd: string }): ContestConfig {
  return parseContestScope({
    allowedFilesRoot: opts.cwd,
    allowPublicNetwork: false,
  })
}
