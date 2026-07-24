import * as fs from 'node:fs'
import * as path from 'node:path'
import { TrajectoryEvent, TrajectoryEventType } from './trajectoryTypes.js'

export class TrajectoryRecorder {
  private logPath: string
  private events: TrajectoryEvent[] = []

  constructor(logPath: string) {
    this.logPath = logPath
    const dir = path.dirname(logPath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
  }

  public record(
    taskId: string,
    eventType: TrajectoryEventType,
    payload: Record<string, any>,
    stateRevision = 1,
    solverRunId?: string,
  ): void {
    // Sanitize secrets / credentials from payload before recording
    const sanitized = this.sanitizePayload(payload)
    const evt: TrajectoryEvent = {
      timestamp: Date.now(),
      taskId,
      solverRunId,
      eventType,
      payload: sanitized,
      stateRevision,
    }

    this.events.push(evt)
    fs.appendFileSync(this.logPath, JSON.stringify(evt) + '\n', 'utf-8')
  }

  public getEvents(): TrajectoryEvent[] {
    return [...this.events]
  }

  private sanitizePayload(payload: Record<string, any>): Record<string, any> {
    const copy = { ...payload }
    const sensitiveKeys = ['apiKey', 'api_key', 'secret', 'password', 'token', 'authorization']
    for (const key of Object.keys(copy)) {
      if (sensitiveKeys.some((s) => key.toLowerCase().includes(s))) {
        copy[key] = '[REDACTED_SECRET]'
      }
    }
    return copy
  }
}
