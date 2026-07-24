import * as fs from 'node:fs'
import * as path from 'node:path'
import type { TrajectoryEvent, TrajectoryEventType } from './trajectoryTypes.js'

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

export class TrajectoryRecorder {
  private logPath: string
  private events: TrajectoryEvent[] = []
  private writeQueue: string[] = []
  private isWriting = false
  private disposed = false
  private getStateRevision?: () => number

  constructor(logPath: string, getStateRevision?: () => number) {
    this.logPath = logPath
    this.getStateRevision = getStateRevision
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
  ): void {
    if (this.disposed) return

    const rev = stateRevision ?? (this.getStateRevision ? this.getStateRevision() : 1)
    const sanitized = this.recursiveSanitize(payload)
    const evt: TrajectoryEvent = {
      timestamp: Date.now(),
      taskId,
      solverRunId,
      eventType,
      payload: sanitized,
      stateRevision: rev,
    }

    this.events.push(evt)
    this.writeQueue.push(JSON.stringify(evt) + '\n')
    this.triggerAsyncWrite()
  }

  public getEvents(): TrajectoryEvent[] {
    return [...this.events]
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
