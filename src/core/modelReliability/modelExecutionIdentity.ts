import type { ModelRole } from './modelCapability.js'

export interface ModelExecutionIdentity {
  taskId: string
  modelRole: ModelRole
  modelProfileId: string
  providerId: string
  capabilityProfileId: string

  modelId?: string
  solverId?: string
  solverRunId?: string
  specialistId?: string

  agentRunId?: string
  workflowRunId?: string
  oneShotRunId?: string
  handoffId?: string

  isOrchestrator: boolean
  isWorkflow?: boolean
  isOneShot?: boolean
}
