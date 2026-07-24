import { spawn } from 'node:child_process'
import { OperatorMessage } from './operatorMessage.js'
import { ExternalSolverAdapter, SolverRunHandle } from './solverAdapter.js'
import { ExternalSolverResult, SolverChallengeInput, SolverHealth, SolverRunRecord } from './solverTypes.js'

export interface GenericProcessSolverOptions {
  executablePath: string
  args?: string[]
  allowedEnvKeys?: string[]
  timeoutMs?: number
}

export class GenericProcessSolverAdapter implements ExternalSolverAdapter {
  public readonly id: string
  private options: GenericProcessSolverOptions

  constructor(id: string, options: GenericProcessSolverOptions) {
    this.id = id
    this.options = options
  }

  public async probe(): Promise<SolverHealth> {
    return {
      status: 'ready',
      capabilities: ['external_process', 'jsonl_protocol'],
    }
  }

  public async start(input: SolverChallengeInput): Promise<SolverRunHandle> {
    const runId = `run_proc_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`
    const timeoutMs = this.options.timeoutMs || 30000

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

    // Filter environment variables strictly (whitelist)
    const allowedKeys = new Set(this.options.allowedEnvKeys || ['PATH', 'HOME', 'LANG', 'TMPDIR'])
    const safeEnv: Record<string, string> = {}
    for (const k of allowedKeys) {
      if (process.env[k]) safeEnv[k] = process.env[k]!
    }

    let isCancelled = false
    let isTimedOut = false

    const waitPromise = new Promise<ExternalSolverResult>((resolve) => {
      // Spawn process with shell: false
      const child = spawn(this.options.executablePath, this.options.args || [], {
        shell: false,
        cwd: input.workspaceDir,
        env: safeEnv,
      })

      const observations: any[] = []
      const artifacts: any[] = []
      const flagCandidates: any[] = []
      const logLines: string[] = []

      const timer = setTimeout(() => {
        isTimedOut = true
        child.kill('SIGKILL')
      }, timeoutMs)

      // Send JSONL start packet to stdin
      const startPacket = JSON.stringify({
        type: 'start',
        runId,
        taskId: input.taskId,
        objective: input.compiledContext.objective,
        workspaceDir: input.workspaceDir,
      })
      child.stdin.write(startPacket + '\n')

      child.stdout.on('data', (data: Buffer) => {
        const lines = data.toString('utf-8').split('\n')
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const parsed = JSON.parse(line)
            if (parsed.type === 'observation') {
              observations.push({
                summary: parsed.summary || 'Process observation',
                confidence: parsed.confidence || 0.8,
                sourcePath: parsed.sourcePath,
              })
            } else if (parsed.type === 'flag_candidate') {
              flagCandidates.push({
                value: parsed.value,
                sourcePath: parsed.sourcePath,
              })
            }
          } catch {
            // NON-JSON lines are saved strictly as raw log output (never directly becoming Evidence)
            logLines.push(line)
          }
        }
      })

      child.on('error', (err) => {
        clearTimeout(timer)
        record.status = 'failed'
        record.failureReason = err.message
        resolve({
          runId,
          solverId: this.id,
          status: 'failed',
          observations: [],
          artifacts: [],
          flagCandidates: [],
          summary: `Process execution error: ${err.message}`,
          metrics: { durationMs: Date.now() - (record.startedAt || Date.now()) },
        })
      })

      child.on('exit', (code) => {
        clearTimeout(timer)
        record.completedAt = Date.now()
        const durationMs = record.completedAt - (record.startedAt || Date.now())

        if (isTimedOut) {
          record.status = 'failed'
          record.failureReason = 'Process execution timed out'
          resolve({
            runId,
            solverId: this.id,
            status: 'failed',
            observations,
            artifacts,
            flagCandidates,
            summary: 'Process timed out and killed',
            metrics: { durationMs },
          })
          return
        }

        if (isCancelled) {
          record.status = 'cancelled'
          resolve({
            runId,
            solverId: this.id,
            status: 'cancelled',
            observations,
            artifacts,
            flagCandidates,
            metrics: { durationMs },
          })
          return
        }

        record.status = flagCandidates.length > 0 ? 'candidate_found' : 'completed'

        resolve({
          runId,
          solverId: this.id,
          status: record.status === 'candidate_found' ? 'flag_candidate' : 'completed',
          observations,
          artifacts,
          flagCandidates,
          metrics: { durationMs },
        })
      })
    })

    return {
      runId,
      solverId: this.id,
      async wait() {
        return waitPromise
      },
      async sendGuidance(msg: OperatorMessage) {
        // Send guidance line to stdin if supported
      },
      async cancel(reason: string) {
        isCancelled = true
        record.status = 'cancelled'
        record.failureReason = reason
      },
      async inspect() {
        return record
      },
    }
  }
}
