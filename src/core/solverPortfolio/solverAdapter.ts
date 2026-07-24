import { OperatorMessage } from './operatorMessage.js'
import {
  ExternalSolverResult,
  SolverChallengeInput,
  SolverHealth,
  SolverRunRecord,
} from './solverTypes.js'

export interface SolverRunHandle {
  runId: string
  solverId: string

  wait(): Promise<ExternalSolverResult>
  sendGuidance(message: OperatorMessage): Promise<void>
  cancel(reason: string): Promise<void>
  inspect(): Promise<SolverRunRecord>
}

export interface ExternalSolverAdapter {
  id: string
  probe(): Promise<SolverHealth>
  start(input: SolverChallengeInput): Promise<SolverRunHandle>
}
