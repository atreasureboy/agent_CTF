export type TrajectoryEventType =
  | 'model_routing_decision'
  | 'compiled_context'
  | 'model_response_schema'
  | 'tool_call'
  | 'attempt'
  | 'observation'
  | 'evidence'
  | 'hypothesis_update'
  | 'suggested_action'
  | 'strategy_decision'
  | 'solver_guidance'
  | 'stagnation'
  | 'candidate'
  | 'validation'
  | 'stop_pause'

export interface TrajectoryEventEnvelope {
  schemaVersion: '1.0'
  eventId: string
  timestamp: number
  taskId: string
  stateRevision: number
  solverRunId?: string
  agentRunId?: string
  attemptId?: string
  eventType: TrajectoryEventType
  payload: unknown
  payloadHash: string
}

export interface TrajectoryEvent {
  timestamp: number
  taskId: string
  solverRunId?: string
  eventType: TrajectoryEventType
  payload: Record<string, any>
  stateRevision: number
}

export interface ModelReliabilityMetrics {
  schemaValidRate: number
  toolArgumentValidRate: number
  duplicateAttemptRate: number
  repeatedActionLoopRate: number
  unsupportedClaimRate: number
  evidenceGainPerAction: number
  successfulActionsPerRun: number
  contextCompilerValidationRate: number
  compactRecoveryRate: number
  retryHandoffResumeRate: number
  flagFalsePositiveRate: number
  averageDurationMs: number
}
