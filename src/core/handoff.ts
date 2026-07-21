/**
 * Handoff — standardized cross-agent baton pass.
 *
 * A specialist Agent emits a HandoffRequest when it has findings/artifacts
 * that another specialist should pick up. The Orchestrator approves, rejects,
 * or modifies the request, then instantiates the receiving Agent with the
 * referenced artifacts already in scope.
 *
 * The receiving Agent inherits Findings + Artifacts — it does NOT re-analyse
 * the upstream artefact from scratch.
 */

import { randomBytes } from 'crypto'
import { appendFileSync, mkdirSync, readFileSync, existsSync, writeFileSync } from 'fs'
import { join } from 'path'

export interface HandoffRequest {
  id: string
  taskId: string
  fromAgent: string
  suggestedAgent: string
  reason: string
  objective: string
  artifactIds: string[]
  findingIds: string[]
  constraints?: string[]
  priority?: number
  createdAt: string
  status: 'pending' | 'approved' | 'rejected' | 'modified'
  decisionReason?: string
}

export interface NewHandoffRequest {
  taskId: string
  fromAgent: string
  suggestedAgent: string
  reason: string
  objective: string
  artifactIds?: string[]
  findingIds?: string[]
  constraints?: string[]
  priority?: number
}

function makeId(): string {
  return `hof_${randomBytes(8).toString('hex')}`
}

export class HandoffStore {
  private readonly filePath: string

  constructor(rootDir: string) {
    this.filePath = join(rootDir, 'handoffs.jsonl')
    mkdirSync(rootDir, { recursive: true })
  }

  submit(input: NewHandoffRequest): HandoffRequest {
    const req: HandoffRequest = {
      id: makeId(),
      taskId: input.taskId,
      fromAgent: input.fromAgent,
      suggestedAgent: input.suggestedAgent,
      reason: input.reason,
      objective: input.objective,
      artifactIds: input.artifactIds ?? [],
      findingIds: input.findingIds ?? [],
      constraints: input.constraints,
      priority: input.priority,
      createdAt: new Date().toISOString(),
      status: 'pending',
    }
    appendFileSync(this.filePath, JSON.stringify(req) + '\n', 'utf8')
    return req
  }

  /** Mark an existing handoff with a decision (approve / reject / modify). */
  decide(id: string, status: 'approved' | 'rejected' | 'modified', reason: string): void {
    if (!existsSync(this.filePath)) return
    const lines = readFileSync(this.filePath, 'utf8').split('\n').filter(Boolean)
    for (let i = 0; i < lines.length; i++) {
      try {
        const r = JSON.parse(lines[i]) as HandoffRequest
        if (r.id === id) {
          r.status = status
          r.decisionReason = reason
          lines[i] = JSON.stringify(r)
          break
        }
      } catch {
        continue
      }
    }
    writeFileSync(this.filePath, lines.join('\n') + (lines.length ? '\n' : ''), 'utf8')
  }

  list(): HandoffRequest[] {
    if (!existsSync(this.filePath)) return []
    const out: HandoffRequest[] = []
    for (const line of readFileSync(this.filePath, 'utf8').split('\n').filter(Boolean)) {
      try {
        out.push(JSON.parse(line) as HandoffRequest)
      } catch {
        continue
      }
    }
    return out
  }

  pending(): HandoffRequest[] {
    return this.list().filter((r) => r.status === 'pending')
  }
}
