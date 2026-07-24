import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHash } from 'crypto'
import type {
  TrajectoryEvent,
  TrajectoryEventEnvelope,
  TrajectoryEventType,
} from './trajectoryTypes.js'

const SENSITIVE_KEYWORDS = [
  'apikey',
  'api_key',
  'secret',
  'password',
  'token',
  'authorization',
  'cookie',
  'auth',
  'bearer',
  'private_key',
]

export interface TrajectoryRecorderLimits {
  maxBufferedEvents: number
  maxWriteQueueBytes: number
  maxPayloadBytes: number
}

export class TrajectoryRecorder {
  private logPath: string
  private ringBuffer: TrajectoryEventEnvelope[] = []
  private writeQueue: string[] = []
  private isWriting = false
  private disposed = false
  private getStateRevision?: () => number
  private limits: TrajectoryRecorderLimits

  constructor(
    logPath: string,
    getStateRevision?: () => number,
    limits: Partial<TrajectoryRecorderLimits> = {},
  ) {
    this.logPath = logPath
    this.getStateRevision = getStateRevision
    this.limits = {
      maxBufferedEvents: limits.maxBufferedEvents ?? 200,
      maxWriteQueueBytes: limits.maxWriteQueueBytes ?? 5_000_000,
      maxPayloadBytes: limits.maxPayloadBytes ?? 500_000,
    }
    const dir = path.dirname(logPath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
  }

  public record(
    taskId: string,
    eventType: TrajectoryEventType,
    payload: Record<string, any>,
    stateRevision?: number,
    solverRunId?: string,
    agentRunId?: string,
    attemptId?: string,
  ): void {
    if (this.disposed) return

    const rev = stateRevision ?? (this.getStateRevision ? this.getStateRevision() : 1)
    const sanitized = this.recursiveSanitize(payload)
    const payloadJson = JSON.stringify(sanitized)
    const payloadHash = createHash('sha256').update(payloadJson).digest('hex')

    const envelope: TrajectoryEventEnvelope = {
      schemaVersion: '1.0',
      eventId: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      timestamp: Date.now(),
      taskId,
      stateRevision: rev,
      solverRunId,
      agentRunId,
      attemptId,
      eventType,
      payload: sanitized,
      payloadHash,
    }

    // Push to bounded ring buffer
    if (this.ringBuffer.length >= this.limits.maxBufferedEvents) {
      this.ringBuffer.shift()
    }
    this.ringBuffer.push(envelope)

    const line = JSON.stringify(envelope) + '\n'
    this.writeQueue.push(line)
    this.triggerAsyncWrite()
  }

  public getEvents(): TrajectoryEvent[] {
    return this.ringBuffer.map((env) => ({
      timestamp: env.timestamp,
      taskId: env.taskId,
      solverRunId: env.solverRunId,
      eventType: env.eventType,
      payload: env.payload as Record<string, any>,
      stateRevision: env.stateRevision,
    }))
  }

  public getEnvelopes(): TrajectoryEventEnvelope[] {
    return [...this.ringBuffer]
  }

  public async flush(): Promise<void> {
    while (this.writeQueue.length > 0 || this.isWriting) {
      if (!this.isWriting && this.writeQueue.length > 0) {
        await this.flushChunk()
      } else {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }
  }

  public async dispose(): Promise<void> {
    this.disposed = true
    await this.flush()
  }

  private triggerAsyncWrite(): void {
    if (this.isWriting || this.writeQueue.length === 0) return
    this.isWriting = true
    Promise.resolve().then(async () => {
      try {
        await this.flushChunk()
      } finally {
        this.isWriting = false
        if (this.writeQueue.length > 0) {
          this.triggerAsyncWrite()
        }
      }
    })
  }

  private async flushChunk(): Promise<void> {
    if (this.writeQueue.length === 0) return
    const chunk = this.writeQueue.splice(0, this.writeQueue.length).join('')
    await fs.promises.appendFile(this.logPath, chunk, 'utf-8')
  }

  private recursiveSanitize(val: any): any {
    if (val === null || val === undefined) return val
    if (typeof val === 'string') return val
    if (typeof val !== 'object') return val

    if (Array.isArray(val)) {
      return val.map((item) => this.recursiveSanitize(item))
    }

    const result: Record<string, any> = {}
    for (const [key, prop] of Object.entries(val)) {
      if (SENSITIVE_KEYWORDS.some((kw) => key.toLowerCase().includes(kw))) {
        result[key] = '[REDACTED_SECRET]'
      } else {
        result[key] = this.recursiveSanitize(prop)
      }
    }
    return result
  }
}
