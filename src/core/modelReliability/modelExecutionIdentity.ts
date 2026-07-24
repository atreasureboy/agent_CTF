import type { ModelRole } from './modelCapability.js'

export interface ModelExecutionIdentity {
  taskId: string
  modelRole: ModelRole

  capabilityProfileId: string

  modelId?: string
  solverId?: string
  specialistId?: string

  agentRunId?: string
  workflowRunId?: string
  oneShotRunId?: string
  handoffId?: string

  isOrchestrator: boolean
  isWorkflow: boolean
  isOneShot: boolean
}
