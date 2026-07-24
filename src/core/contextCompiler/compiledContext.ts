import { ModelRole } from '../modelReliability/modelCapability.js'

export type CompilerType =
  | 'challenge_prompt'
  | 'solver_brief'
  | 'progress_handoff'
  | 'retry_handoff'
  | 'specialist_context'

export interface CompiledEvidenceRef {
  id: string
  title: string
  factSummary: string
  confidence: number
}

export interface CompiledHypothesisRef {
  id: string
  title: string
  status: 'active' | 'confirmed' | 'rejected' | 'pending'
  reasoning?: string
}

export interface CompiledAttemptRef {
  id: string
  actionSummary: string
  fingerprint: string
  outcome: string
  reason?: string
}

export interface CompiledArtifactRef {
  id: string
  path: string
  sha256?: string
  description: string
}

export interface CompiledActionRef {
  id: string
  actionName: string
  target: string
  rationale: string
}

export interface CompiledContext {
  id: string
  taskId: string
  compilerType: CompilerType
  compilerVersion: string

  stateRevision: number
  stateSnapshotHash: string

  targetModelId: string
  targetRole: ModelRole

  objective: string
  scopeSummary: string

  confirmedEvidence: CompiledEvidenceRef[]
  activeHypotheses: CompiledHypothesisRef[]
  rejectedHypotheses: CompiledHypothesisRef[]

  failedAttempts: CompiledAttemptRef[]
  importantArtifacts: CompiledArtifactRef[]

  currentBlocker?: string

  recommendedActions: CompiledActionRef[]
  forbiddenRepeats: string[]

  allowedToolIds: string[]
  completionContract: string[]

  sourceIds: string[]
  renderedText?: string

  estimatedTokens: number
  createdAt: number
}
