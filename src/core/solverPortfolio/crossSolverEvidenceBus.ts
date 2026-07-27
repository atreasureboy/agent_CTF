import { CrossSolverKnowledgeView } from './crossSolverKnowledgeView.js'

export interface SolverEvidenceCursor {
  solverRunId: string
  lastSeenStateRevision: number
  seenMessageIds: Set<string>
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
  private knowledgeView?: CrossSolverKnowledgeView
  private publishedMessages: SolverEvidenceMessage[] = []
  private stateStore?: any
  private cursors = new Map<string, SolverEvidenceCursor>()

  constructor(stateStore?: any) {
    this.stateStore = stateStore
    if (stateStore) {
      this.knowledgeView = new CrossSolverKnowledgeView(stateStore)
    }
  }

  public setStore(stateStore: any): void {
    this.stateStore = stateStore
    this.knowledgeView = new CrossSolverKnowledgeView(stateStore)
  }

  public publish(msg: SolverEvidenceMessage): void {
    // Enforcement: Messages without grounded IDs (evidenceIds, observationIds, artifactIds)
    // are ungrounded natural language and cannot enter the evidence bus
    if (
      (!msg.evidenceIds || msg.evidenceIds.length === 0) &&
      (!msg.observationIds || msg.observationIds.length === 0) &&
      (!msg.artifactIds || msg.artifactIds.length === 0)
    ) {
      return
    }

    if (this.stateStore && msg.evidenceIds?.length) {
      try {
        for (const evId of msg.evidenceIds) {
          this.stateStore.apply({
            type: 'EVIDENCE_RECORDED',
            evidence: {
              id: evId,
              claim: msg.summary,
              confidence: msg.priority === 'high' ? 0.9 : 0.8,
              polarity: 'supports',
              sourceSolverRunId: msg.sourceSolverRunId,
              observationIds: msg.observationIds || [],
              sources: [{ id: 'src_1', producer: { runId: msg.sourceSolverRunId } }],
              createdAt: msg.createdAt || Date.now(),
            },
          })
        }
      } catch {
        /* best effort */
      }
    }

    if (!this.publishedMessages.some((m) => m.id === msg.id)) {
      this.publishedMessages.push(msg)
    }
  }

  public getUnreadMessages(
    taskId: string,
    solverRunId: string,
    currentRevision: number,
    limit = 5,
  ): SolverEvidenceMessage[] {
    if (this.knowledgeView) {
      const msgs = this.knowledgeView.getUnread({
        taskId,
        solverRunId,
        afterRevision: 0,
        limit,
      })
      if (msgs.length > 0) {
        return msgs.map((m) => {
          const orig = this.publishedMessages.find((pm) => pm.id === m.id)
          return {
            id: m.id,
            taskId: m.taskId,
            sourceSolverRunId: m.sourceSolverRunId ?? 'unknown',
            stateRevision: m.stateRevision,
            evidenceIds: m.evidenceIds,
            observationIds: m.observationIds,
            artifactIds: m.artifactIds,
            summary: orig?.summary || `Grounded evidence [${m.evidenceIds.join(', ')}] from ${m.sourceSolverRunId}`,
            priority: m.priority as any,
            createdAt: m.createdAt,
          }
        })
      }
    }

    let cursor = this.cursors.get(solverRunId)
    if (!cursor) {
      cursor = { solverRunId, lastSeenStateRevision: 0, seenMessageIds: new Set<string>() }
      this.cursors.set(solverRunId, cursor)
    }

    const unread = this.publishedMessages.filter(
      (m) =>
        m.taskId === taskId &&
        m.sourceSolverRunId !== solverRunId &&
        !cursor!.seenMessageIds.has(m.id),
    )
    const selected = unread.slice(0, limit)
    for (const m of selected) {
      cursor.seenMessageIds.add(m.id)
    }
    return selected
  }

  public dispose(): void {
    this.knowledgeView?.dispose()
    this.publishedMessages = []
    this.cursors.clear()
  }

  public clear(): void {
    this.dispose()
  }
}
