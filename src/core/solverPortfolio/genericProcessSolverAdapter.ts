import { spawn } from 'node:child_process'
import { existsSync, accessSync, constants } from 'node:fs'
import type { OperatorMessage } from './operatorMessage.js'
import type { ExternalSolverAdapter, SolverRunHandle } from './solverAdapter.js'
import type {
  ExternalSolverResult,
  SolverChallengeInput,
  SolverHealth,
  SolverRunRecord,
} from './solverTypes.js'

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
    await Promise.resolve()
    try {
      if (!existsSync(this.options.executablePath) && !this.options.executablePath.includes('/')) {
        // Simple executable name like 'node' or 'codex'
      } else if (existsSync(this.options.executablePath)) {
        accessSync(this.options.executablePath, constants.X_OK)
      }
      return {
        status: 'ready',
        capabilities: ['external_process', 'jsonl_protocol'],
      }
    } catch (err) {
      return {
        status: 'unavailable',
        capabilities: [],
        reason: `Process probe failed for binary ${this.options.executablePath}: ${(err as Error).message}`,
      }
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

    const allowedKeys = new Set(this.options.allowedEnvKeys || ['PATH', 'HOME', 'LANG', 'TMPDIR'])
    const safeEnv: Record<string, string> = {}
    for (const k of allowedKeys) {
      if (process.env[k]) safeEnv[k] = process.env[k]!
    }

    let isCancelled = false
    let isTimedOut = false
    let cancelReason = ''
    let childProcess: ReturnType<typeof spawn> | undefined

    const waitPromise = new Promise<ExternalSolverResult>((resolve) => {
      const child = spawn(this.options.executablePath, this.options.args || [], {
        shell: false,
        cwd: input.workspaceDir,
        env: safeEnv,
      })
      childProcess = child

      const observations: any[] = []
      const artifacts: any[] = []
      const flagCandidates: any[] = []
      const logLines: string[] = []
      let pendingBuffer = ''

      const timer = setTimeout(() => {
        isTimedOut = true
        child.kill('SIGKILL')
      }, timeoutMs)

      if (input.signal) {
        input.signal.addEventListener(
          'abort',
          () => {
            isCancelled = true
            child.kill('SIGTERM')
          },
          { once: true },
        )
      }

      const startPacket = JSON.stringify({
        type: 'start',
        protocolVersion: '1.0.0',
        runId,
        taskId: input.taskId,
        objective: input.compiledContext.objective,
        scopeSummary: input.compiledContext.scopeSummary,
        workspaceDir: input.workspaceDir,
        completionContract: input.compiledContext.completionContract,
        allowedTools: input.compiledContext.allowedToolIds,
      })
      if (child.stdin.writable) {
        child.stdin.write(startPacket + '\n')
      }

      const processLine = (line: string) => {
        const trimmed = line.trim()
        if (!trimmed) return
        try {
          const parsed = JSON.parse(trimmed)
          if (parsed.type === 'observation') {
            observations.push({
              summary: parsed.summary || 'Process observation',
              confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.8,
              sourcePath: parsed.sourcePath,
            })
          } else if (parsed.type === 'flag_candidate') {
            flagCandidates.push({
              value: parsed.value,
              sourcePath: parsed.sourcePath,
            })
          } else if (parsed.type === 'artifact') {
            artifacts.push({
              path: parsed.path || parsed.artifactId,
              description: parsed.description || 'Process artifact',
            })
          }
        } catch {
          logLines.push(trimmed)
        }
      }

      child.stdout.on('data', (data: Buffer) => {
        pendingBuffer += data.toString('utf-8')
        let idx: number
        while ((idx = pendingBuffer.indexOf('\n')) !== -1) {
          const line = pendingBuffer.slice(0, idx)
          pendingBuffer = pendingBuffer.slice(idx + 1)
          processLine(line)
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

      child.on('exit', () => {
        clearTimeout(timer)
        if (pendingBuffer.trim()) {
          processLine(pendingBuffer)
          pendingBuffer = ''
        }

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
          record.failureReason = cancelReason
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
        if (childProcess && childProcess.stdin && childProcess.stdin.writable) {
          const packet = JSON.stringify({
            type: 'guidance',
            operatorMessage: msg,
            text: msg.type === 'hint' ? msg.text : JSON.stringify(msg),
            createdAt: Date.now(),
          })
          childProcess.stdin.write(packet + '\n')
        }
      },
      async cancel(reason: string) {
        isCancelled = true
        cancelReason = reason
        record.status = 'cancelled'
        record.failureReason = reason
        if (childProcess) {
          childProcess.kill('SIGTERM')
          setTimeout(() => {
            if (childProcess && !childProcess.killed) {
              childProcess.kill('SIGKILL')
            }
          }, 2000)
        }
      },
      async inspect() {
        return record
      },
    }
  }
}
