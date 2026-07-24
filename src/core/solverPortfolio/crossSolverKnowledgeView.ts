import type { CTFTaskStateStore } from '../ctfRuntime/taskStateStore.js'

export type KnowledgePriority = 'low' | 'medium' | 'high'

export interface SolverKnowledgeMessage {
  id: string
  taskId: string
  sourceSolverRunId: string
  stateRevision: number

  evidenceIds: string[]
  observationIds: string[]
  artifactIds: string[]
  candidateIds: string[]

  priority: KnowledgePriority
  createdAt: number
}

export class CrossSolverKnowledgeView {
  private stateStore: CTFTaskStateStore
  private readCursors = new Map<string, Set<string>>()

  constructor(stateStore: CTFTaskStateStore) {
    this.stateStore = stateStore
  }

  public getUnread(input: {
    taskId: string
    solverRunId: string
    afterRevision: number
    limit: number
  }): SolverKnowledgeMessage[] {
    const state = this.stateStore.getState()
    if (!state) return []

    let seen = this.readCursors.get(input.solverRunId)
    if (!seen) {
      seen = new Set<string>()
      this.readCursors.set(input.solverRunId, seen)
    }

    const currentRevision = (state as any).revision ?? 1
    if (input.afterRevision >= currentRevision) return []

    const messages: SolverKnowledgeMessage[] = []

    for (const ev of state.evidence) {
      const sourceRunId =
        (ev as any).sourceSolverRunId ||
        (ev.sources?.[0]?.producer as any)?.runId ||
        (ev.sources?.[0]?.producer as any)?.id
      if (sourceRunId && sourceRunId !== input.solverRunId) {
        const msgId = `msg_ev_${ev.id}`
        if (!seen.has(msgId)) {
          messages.push({
            id: msgId,
            taskId: input.taskId,
            sourceSolverRunId: sourceRunId,
            stateRevision: currentRevision,
            evidenceIds: [ev.id],
            observationIds: (ev as any).observationIds || [],
            artifactIds: [],
            candidateIds: [],
            priority: ev.confidence >= 0.8 ? 'high' : 'medium',
            createdAt: Date.now(),
          })
        }
      }
    }

    const unread = messages.slice(0, input.limit)
    for (const msg of unread) {
      seen.add(msg.id)
    }

    return unread
  }

  public dispose(): void {
    this.readCursors.clear()
  }
}
