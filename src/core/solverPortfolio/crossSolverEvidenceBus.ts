import { CrossSolverKnowledgeView } from './crossSolverKnowledgeView.js'
import type { CTFTaskStateStore } from '../ctfRuntime/taskStateStore.js'

export interface SolverEvidenceCursor {
  solverRunId: string
  lastSeenStateRevision: number
  seenMessageIds: Set<string>
}

export interface KnowledgePublishResult {
  accepted: boolean
  reason?: string
}

export interface SolverEvidenceMessage {
  id: string
  taskId: string
  sourceSolverRunId: string
  stateRevision?: number
  evidenceIds: string[]
  observationIds: string[]
  artifactIds: string[]
  summary: string
  priority: 'low' | 'normal' | 'high' | 'critical'
  createdAt: number
  expiresAt?: number
}

export class CrossSolverEvidenceBus {
  private knowledgeView: CrossSolverKnowledgeView
  private stateStore: CTFTaskStateStore
  private cursors = new Map<string, SolverEvidenceCursor>()

  constructor(stateStore: CTFTaskStateStore) {
    if (!stateStore) {
      throw new Error('[CrossSolverEvidenceBus] Mandatory stateStore dependency missing.')
    }
    this.stateStore = stateStore
    this.knowledgeView = new CrossSolverKnowledgeView(this.stateStore)
  }

  public setStore(stateStore: CTFTaskStateStore): void {
    if (!stateStore) {
      throw new Error('[CrossSolverEvidenceBus] Mandatory stateStore dependency missing.')
    }
    this.stateStore = stateStore
    this.knowledgeView = new CrossSolverKnowledgeView(stateStore)
  }

  public publish(msg: SolverEvidenceMessage): KnowledgePublishResult {
    // Enforcement: Messages without grounded IDs (evidenceIds, observationIds, artifactIds)
    // are ungrounded natural language and CANNOT enter the evidence bus.
    const hasGroundedId =
      (msg.evidenceIds && msg.evidenceIds.length > 0) ||
      (msg.observationIds && msg.observationIds.length > 0) ||
      (msg.artifactIds && msg.artifactIds.length > 0)

    if (!hasGroundedId) {
      return {
        accepted: false,
        reason: 'Ungrounded message: lacks evidenceIds, observationIds, and artifactIds.',
      }
    }

    // Verify all grounded IDs actually exist in CTFTaskStateStore
    const state = this.stateStore.getState()
    const validEvIds = msg.evidenceIds.filter((id) =>
      state.evidence.some((e: { id: string }) => e.id === id),
    )
    const validObsIds = msg.observationIds.filter((id) =>
      state.observations.some((o: { id: string }) => o.id === id),
    )
    const validArtIds = msg.artifactIds.filter((id) => state.artifactIds.includes(id))

    if (validEvIds.length === 0 && validObsIds.length === 0 && validArtIds.length === 0) {
      // IDs provided do not exist in physical TaskStateStore yet. Reject ungrounded broadcast.
      return {
        accepted: false,
        reason: 'Provided IDs do not exist in physical TaskStateStore yet.',
      }
    }

    return { accepted: true }
  }

  public getUnreadMessages(
    taskId: string,
    solverRunId: string,
    currentRevision?: number,
    limit = 5,
  ): SolverEvidenceMessage[] {
    let cursor = this.cursors.get(solverRunId)
    if (!cursor) {
      cursor = {
        solverRunId,
        lastSeenStateRevision: 0,
        seenMessageIds: new Set<string>(),
      }
      this.cursors.set(solverRunId, cursor)
    }

    const afterRev = cursor.lastSeenStateRevision

    const msgs = this.knowledgeView.getUnread({
      taskId,
      solverRunId,
      afterRevision: afterRev,
      limit,
    })

    if (msgs.length > 0) {
      const resultMsgs: SolverEvidenceMessage[] = []
      const state = this.stateStore.getState()

      for (const m of msgs) {
        if (cursor.seenMessageIds.has(m.id)) continue

        cursor.seenMessageIds.add(m.id)
        if (m.stateRevision > cursor.lastSeenStateRevision) {
          cursor.lastSeenStateRevision = m.stateRevision
        }

        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument
        const ev = state.evidence.find((e: any) => m.evidenceIds.includes(e.id))
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument
        const obs = state.observations.find((o: any) => m.observationIds.includes(o.id))

        resultMsgs.push({
          id: m.id,
          taskId: m.taskId,
          sourceSolverRunId: m.sourceSolverRunId ?? 'unknown',
          stateRevision: m.stateRevision,
          evidenceIds: m.evidenceIds,
          observationIds: m.observationIds,
          artifactIds: m.artifactIds,
          summary: ev?.claim || obs?.summary || `Grounded state update from ${m.sourceSolverRunId}`,
          priority: m.priority === 'high' ? 'high' : 'normal',
          createdAt: m.createdAt,
        })
      }

      return resultMsgs
    }

    return []
  }

  public dispose(): void {
    this.knowledgeView.dispose()
    this.cursors.clear()
  }

  public clear(): void {
    this.dispose()
  }
}
