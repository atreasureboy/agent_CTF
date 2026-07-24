import { CompiledContext } from '../contextCompiler/compiledContext.js'
import { ModelRole } from '../modelReliability/modelCapability.js'

export type SolverRunStatus =
  | 'queued'
  | 'running'
  | 'stagnating'
  | 'paused'
  | 'completed'
  | 'candidate_found'
  | 'gave_up'
  | 'cancelled'
  | 'failed'

export interface SolverRunRecord {
  id: string
  taskId: string

  solverId: string
  modelId?: string
  role: ModelRole

  status: SolverRunStatus

  contextCompilerId: string
  compiledContextId: string

  observationIds: string[]
  evidenceIds: string[]
  artifactIds: string[]
  flagCandidateIds: string[]

  guidanceMessageIds: string[]

  startedAt?: number
  completedAt?: number

  failureReason?: string
}

export interface SolverHealth {
  status: 'ready' | 'degraded' | 'unavailable'
  capabilities: string[]
  reason?: string
}

export interface SolverChallengeInput {
  taskId: string
  challengeId: string
  compiledContext: CompiledContext
  workspaceDir: string
  artifactIds: string[]
  scopeSummary: string
  signal?: AbortSignal
}

export interface ExternalObservationDraft {
  summary: string
  confidence: number
  sourcePath?: string
}

export interface ExternalFlagCandidateDraft {
  value: string
  sourcePath?: string
}

export interface ExternalArtifactDraft {
  path: string
  description: string
}

export interface ExternalSolverResult {
  runId: string
  solverId: string
  status:
    | 'completed'
    | 'flag_candidate'
    | 'gave_up'
    | 'cancelled'
    | 'failed'
    | 'quota_error'

  observations: ExternalObservationDraft[]
  artifacts: ExternalArtifactDraft[]
  flagCandidates: ExternalFlagCandidateDraft[]

  summary?: string

  metrics: {
    durationMs: number
    inputTokens?: number
    outputTokens?: number
    estimatedCost?: number
  }
}
