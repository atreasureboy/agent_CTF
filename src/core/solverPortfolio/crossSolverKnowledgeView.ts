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

    const currentRevision = typeof this.stateStore.getRevision === 'function'
      ? this.stateStore.getRevision(input.taskId)
      : ((state as any).revision ?? (state as any).stateRevision ?? 1)

    // Only return updates if current revision is greater than afterRevision
    if (input.afterRevision > 0 && currentRevision <= input.afterRevision) {
      return []
    }

    const messages: SolverKnowledgeMessage[] = []

    for (const ev of state.evidence) {
      const evTaskId = (ev as any).taskId || (ev as any).task_id || state.taskId
      if (evTaskId && input.taskId && evTaskId !== input.taskId) {
        continue
      }
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
            observationIds: (ev as any).observationIds || (ev.sources || []).flatMap((s: any) => s.observationIds || []),
            artifactIds: (ev as any).artifactIds || (ev.sources || []).flatMap((s: any) => s.artifactIds || []),
            candidateIds: [],
            priority: ev.confidence >= 0.8 ? 'high' : 'medium',
            createdAt: ev.createdAt || Date.now(),
          })
        }
      }
    }

    for (const obs of state.observations) {
      const obsTaskId = (obs as any).taskId || state.taskId
      if (obsTaskId && input.taskId && obsTaskId !== input.taskId) {
        continue
      }
      const sourceRunId = (obs as any).sourceSolverRunId || (obs as any).producerId
      if (sourceRunId && sourceRunId !== input.solverRunId) {
        const msgId = `msg_obs_${obs.id}`
        if (!seen.has(msgId)) {
          messages.push({
            id: msgId,
            taskId: input.taskId,
            sourceSolverRunId: sourceRunId,
            stateRevision: currentRevision,
            evidenceIds: [],
            observationIds: [obs.id],
            artifactIds: (obs as any).artifactIds || [],
            candidateIds: [],
            priority: 'medium',
            createdAt: obs.createdAt || Date.now(),
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
