/**
 * OneShot — public type definitions for the CTF shotgun execution layer.
 *
 * Manifests describe one third-party tool integration in declarative form so
 * the framework can dispatch generically across Process / Container / Service
 * runners. The runtime owns no per-tool `if/else` branching.
 *
 * File-scope fixes (Phase A):
 *   - One normalized result model (`OneShotResult`) is the single contract
 *     between any runner and the Agent: stdout/stderr never travels back to
 *     the LLM raw, only the normalized findings/artifacts/candidates plus
 *     a short summary path.
 *   - Maturity tiers (stable / candidate / experimental) and `enabledByDefault`
 *     let the Doctor command reason about the manifest catalog.
 */

import type { z } from 'zod'
import type { oneShotManifestSchema } from './manifestSchema.js'

export type OneShotManifestInput = z.input<typeof oneShotManifestSchema>
export type OneShotManifest = z.output<typeof oneShotManifestSchema>

export type OneShotRunnerType = 'process' | 'container' | 'service'
export type OneShotLane = 'fast' | 'medium' | 'heavy'
export type OneShotNetworkMode = 'none' | 'contest-target-only' | 'outbound-readonly'
export type OneShotMaturity = 'stable' | 'candidate' | 'experimental'
export type OneShotFalsePositiveRisk = 'low' | 'medium' | 'high'

export const ONESHOT_LANES: ReadonlyArray<OneShotLane> = ['fast', 'medium', 'heavy'] as const
export const ONESHOT_NETWORK_MODES: ReadonlyArray<OneShotNetworkMode> = [
  'none',
  'contest-target-only',
  'outbound-readonly',
] as const

/**
 * Normalized finding — same envelope CTFTaskState already understands, scoped
 * to a single one-shot run. The Projector converts these to FINDING_ADDED
 * events so the parent task sees them via the same audit/log surface.
 */
export interface NormalizedFinding {
  category: string
  title: string
  summary: string
  confidence: 'low' | 'medium' | 'high'
  evidence?: string[]
  recommendedNextActions?: string[]
  suggestedAgent?: string
}

export interface NormalizedArtifact {
  type: string
  /** Relative path under the run's artifact root. */
  path: string
  size: number
  sha256: string
  mimeType?: string
  /** Original tool-provided hint (e.g. "binwalk-extracted/cp.png"). */
  hint?: string
}

export interface CandidateValue {
  value: string
  /** Other run ids that reported the same flag value. Populated post-dedup. */
  sourceRuns: string[]
  /** Artifact paths that referenced this candidate. */
  sourceArtifacts: string[]
  confidence: number
  needsVerification: boolean
}

export type OneShotStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'partial'
  | 'timeout'
  | 'cancelled'
  | 'failed'
  | 'unavailable'

export interface OneShotDiagnostics {
  exitCode?: number
  signal?: string
  stdoutPath?: string
  stderrPath?: string
  truncated: boolean
  parserWarnings: string[]
}

/**
 * One run's outcome. Sent to Agent as the structure returned from
 * `runOneShot`, mirroring the BackgroundJob lifecycle but richer.
 */
export interface OneShotResult {
  runId: string
  manifestId: string
  taskId: string
  status: OneShotStatus
  startedAt: string
  finishedAt?: string
  durationMs?: number
  findings: NormalizedFinding[]
  artifacts: NormalizedArtifact[]
  candidates: CandidateValue[]
  diagnostics: OneShotDiagnostics
  confidence: number
  falsePositiveRisk: OneShotFalsePositiveRisk
  /** Free-form summary the Agent sees instead of raw output. */
  summary: string
}

/** Outcomes fed to the BackgroundJobManager for projection. */
export interface OneShotJobProjectionEvent {
  type:
    | 'ONESHOT_QUEUED'
    | 'ONESHOT_STARTED'
    | 'ONESHOT_PROGRESS'
    | 'ONESHOT_FINDING'
    | 'ONESHOT_ARTIFACT'
    | 'ONESHOT_CANDIDATE'
    | 'ONESHOT_COMPLETED'
    | 'ONESHOT_TIMEOUT'
    | 'ONESHOT_FAILED'
    | 'ONESHOT_CANCELLED'
  runId: string
  manifestId: string
  taskId: string
  lane: OneShotLane
  at: string
  /** Free-form payload depending on event type. */
  detail?: Record<string, unknown>
}

/** Doctor output states — keep wording identical to the goal §十四 example. */
export type DoctorStatus =
  'READY' | 'DEGRADED' | 'DISABLED_HEAVY' | 'DISABLED_SCOPE_REQUIRED' | 'UNAVAILABLE'

export interface DoctorRow {
  category: string
  manifestId: string
  displayName: string
  status: DoctorStatus
  reason?: string
  version?: string
}

export interface ScopeRule {
  hosts: string[]
  domains: string[]
  ports: number[]
  cidrs: string[]
}

/** Budget limits — one per-lane, per-task. */
export interface BudgetLimits {
  fastConcurrency: number
  mediumConcurrency: number
  heavyConcurrency: number
  perTaskMaxRuns: number
  perTaskHeavyRuns: number
}

export const DEFAULT_BUDGET_LIMITS: BudgetLimits = {
  fastConcurrency: 8,
  mediumConcurrency: 3,
  heavyConcurrency: 1,
  perTaskMaxRuns: 12,
  perTaskHeavyRuns: 1,
}

/** All values exported together for ergonomic consumption. */
export type { OneShotRunnerType as OneShotRunnerTypeRe }
