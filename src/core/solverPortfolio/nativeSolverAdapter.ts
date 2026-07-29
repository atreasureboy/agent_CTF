import type { OperatorMessage } from './operatorMessage.js'
import type { ExternalSolverAdapter, SolverRunHandle } from './solverAdapter.js'
import type {
  ExternalSolverResult,
  SolverChallengeInput,
  SolverEvent,
  SolverHealth,
  SolverRunRecord} from './solverTypes.js';
import {
  SolverUnavailableError,
} from './solverTypes.js'
import type { CTFTaskState } from '../ctfRuntime/taskState.js'

export interface NativeSolverRuntimeDelegate {
  run?(input: SolverChallengeInput): Promise<{
    summary?: string
    observations?: Array<{ summary: string; confidence: number; sourcePath?: string }>
    artifacts?: Array<{ path: string; description: string }>
    flagCandidates?: Array<{ value: string; confidence: number }>
  }>
  runMainAgent?(input: SolverChallengeInput): Promise<{
    summary?: string
    observations?: Array<{ summary: string; confidence: number; sourcePath?: string }>
    artifacts?: Array<{ path: string; description: string }>
    flagCandidates?: Array<{ value: string; confidence: number }>
  }>
  runWorkflow?(
    workflowId: string,
    input: SolverChallengeInput,
  ): Promise<{
    summary?: string
    observations?: Array<{ summary: string; confidence: number }>
    artifacts?: Array<{ path: string; description: string }>
  }>
  cancel?(reason: string): Promise<void>
  inspectState?(): Readonly<CTFTaskState>
  sendGuidance?(message: string): Promise<void>
}

export class NativeSolverAdapter implements ExternalSolverAdapter {
  public readonly id = 'native-ctf-solver'
  private delegate?: NativeSolverRuntimeDelegate

  constructor(delegate?: NativeSolverRuntimeDelegate) {
    this.delegate = delegate
  }

  public setDelegate(delegate: NativeSolverRuntimeDelegate): void {
    this.delegate = delegate
  }

  public async probe(): Promise<SolverHealth> {
    await Promise.resolve()
    const d = this.delegate as any
    if (!d || (!d.runMainAgent && !d.runWorkflow && !d.run)) {
      return {
        status: 'unavailable',
        reason: 'NativeSolverRuntimeDelegate not configured or lacks execution methods',
        capabilities: ['native_task_runtime', 'structured_reasoning', 'workflow_dag'],
      }
    }
    return {
      status: 'ready',
      capabilities: ['native_task_runtime', 'structured_reasoning', 'workflow_dag'],
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  public async start(input: SolverChallengeInput): Promise<SolverRunHandle> {
    if (!this.delegate) {
      throw new SolverUnavailableError(this.id, 'NativeSolverRuntimeDelegate not configured')
    }

    const runId = `run_native_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`
    let cancelled = false
    let cancelReason = ''
    const guidanceLog: OperatorMessage[] = []
    const startTime = Date.now()
    const eventQueue: SolverEvent[] = []
    let eventResolver: (() => void) | null = null

    const emitEvent = (ev: SolverEvent) => {
      eventQueue.push(ev)
      if (eventResolver) {
        eventResolver()
        eventResolver = null
      }
    }

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
      startedAt: startTime,
    }

    emitEvent({ type: 'status', status: 'running', timestamp: startTime })

    const waitPromise = (async (): Promise<ExternalSolverResult> => {
      if (cancelled) {
        record.status = 'cancelled'
        record.failureReason = cancelReason
        emitEvent({ type: 'status', status: 'cancelled', timestamp: Date.now() })
        return {
          runId,
          solverId: this.id,
          status: 'cancelled',
          observations: [],
          artifacts: [],
          flagCandidates: [],
          metrics: { durationMs: Date.now() - startTime },
        }
      }

      if (this.delegate?.run) {
        const out = await this.delegate.run(input)
        record.status = 'completed'
        record.completedAt = Date.now()
        emitEvent({ type: 'status', status: 'completed', timestamp: Date.now() })
        return {
          runId,
          solverId: this.id,
          status: 'completed',
          summary: (out as any).summary,
          observations: (out as any).observations || [],
          artifacts: (out as any).artifacts || [],
          flagCandidates: (out as any).flagCandidates || [],
          metrics: { durationMs: Date.now() - startTime },
        }
      }

      if (this.delegate?.runMainAgent) {
        const out = await this.delegate.runMainAgent(input)
        record.status = 'completed'
        record.completedAt = Date.now()
        emitEvent({ type: 'status', status: 'completed', timestamp: Date.now() })
        return {
          runId,
          solverId: this.id,
          status: 'completed',
          summary: out.summary,
          observations: out.observations || [],
          artifacts: out.artifacts || [],
          flagCandidates: out.flagCandidates || [],
          metrics: { durationMs: Date.now() - startTime },
        }
      }

      if (this.delegate?.runWorkflow) {
        const out = await this.delegate.runWorkflow('default', input)
        record.status = 'completed'
        record.completedAt = Date.now()
        emitEvent({ type: 'status', status: 'completed', timestamp: Date.now() })
        return {
          runId,
          solverId: this.id,
          status: 'completed',
          summary: out.summary,
          observations: out.observations || [],
          artifacts: out.artifacts || [],
          flagCandidates: [],
          metrics: { durationMs: Date.now() - startTime },
        }
      }

      record.status = 'failed'
      record.failureReason = 'NativeSolverRuntimeDelegate has no executable method (run/runMainAgent/runWorkflow)'
      emitEvent({ type: 'status', status: 'failed', timestamp: Date.now() })
      throw new SolverUnavailableError(this.id, record.failureReason)
    })()

    const delegate = this.delegate
    return {
      runId,
      solverId: this.id,
      async wait() {
        return waitPromise
      },
      async *events() {
        let index = 0
        while (true) {
          if (index < eventQueue.length) {
            yield eventQueue[index++]
            continue
          }
          if (
            record.status === 'completed' ||
            record.status === 'cancelled' ||
            record.status === 'failed'
          ) {
            break
          }
          await new Promise<void>((resolve) => {
            eventResolver = resolve
          })
        }
      },
      async sendGuidance(msg: OperatorMessage) {
        guidanceLog.push(msg)
        const text = msg.type === 'hint' ? msg.text : JSON.stringify(msg)
        if (delegate?.sendGuidance) {
          await delegate.sendGuidance(text)
        }
      },
      async cancel(reason: string) {
        cancelled = true
        cancelReason = reason
        record.status = 'cancelled'
        emitEvent({ type: 'status', status: 'cancelled', timestamp: Date.now() })
        if (delegate?.cancel) {
          await delegate.cancel(reason)
        }
      },
      // eslint-disable-next-line @typescript-eslint/require-await
      async inspect() {
        return record
      },
    }
  }
}
