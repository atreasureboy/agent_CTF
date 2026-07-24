import { OperatorMessage } from './operatorMessage.js'
import { ExternalSolverAdapter, SolverRunHandle } from './solverAdapter.js'
import { ExternalSolverResult, SolverChallengeInput, SolverHealth, SolverRunRecord } from './solverTypes.js'

export class NativeSolverAdapter implements ExternalSolverAdapter {
  public readonly id = 'native-ctf-solver'

  public async probe(): Promise<SolverHealth> {
    return {
      status: 'ready',
      capabilities: ['native_task_runtime', 'structured_reasoning', 'workflow_dag'],
    }
  }

  public async start(input: SolverChallengeInput): Promise<SolverRunHandle> {
    const runId = `run_native_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`
    let cancelled = false
    let cancelReason = ''
    const guidanceLog: OperatorMessage[] = []

    const record: SolverRunRecord = {
      id: runId,
      taskId: input.taskId,
      solverId: this.id,
      role: input.compiledContext.targetRole,
      status: 'running',
      contextCompilerId: input.compiledContext.compilerType,
      compiledContextId: input.compiledContext.id,
      observationIds: [],
      evidenceIds: [],
      artifactIds: [],
      flagCandidateIds: [],
      guidanceMessageIds: [],
      startedAt: Date.now(),
    }

    const waitPromise = (async (): Promise<ExternalSolverResult> => {
      // Simulate native runtime cycle
      if (cancelled) {
        record.status = 'cancelled'
        record.failureReason = cancelReason
        return {
          runId,
          solverId: this.id,
          status: 'cancelled',
          observations: [],
          artifacts: [],
          flagCandidates: [],
          metrics: { durationMs: 10 },
        }
      }

      record.status = 'completed'
      record.completedAt = Date.now()

      return {
        runId,
        solverId: this.id,
        status: 'completed',
        observations: [
          {
            summary: `Native solver executed context: ${input.compiledContext.objective}`,
            confidence: 0.9,
          },
        ],
        artifacts: [],
        flagCandidates: [],
        metrics: {
          durationMs: (record.completedAt || Date.now()) - (record.startedAt || Date.now()),
        },
      }
    })()

    return {
      runId,
      solverId: this.id,
      async wait() {
        return waitPromise
      },
      async sendGuidance(msg: OperatorMessage) {
        guidanceLog.push(msg)
      },
      async cancel(reason: string) {
        cancelled = true
        cancelReason = reason
        record.status = 'cancelled'
      },
      async inspect() {
        return record
      },
    }
  }
}
