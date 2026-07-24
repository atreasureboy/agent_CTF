export type OperatorMessage =
  | { type: 'hint'; text: string }
  | { type: 'force_branch'; objective: string }
  | { type: 'approve_expensive'; actionId: string }
  | { type: 'change_priority'; priority: number }
  | { type: 'pause'; reason: string }
  | { type: 'resume' }
  | { type: 'stop'; reason: string }

export interface OperatorMessageRecord {
  id: string
  taskId: string
  solverRunId?: string
  message: OperatorMessage
  timestamp: number
  applied: boolean
}
