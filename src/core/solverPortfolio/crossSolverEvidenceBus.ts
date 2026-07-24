export interface SolverEvidenceCursor {
  solverRunId: string
  lastSeenStateRevision: number
}

export interface SolverEvidenceMessage {
  id: string
  taskId: string
  sourceSolverRunId: string
  evidenceIds: string[]
  observationIds: string[]
  artifactIds: string[]
  summary: string
  priority: 'low' | 'normal' | 'high' | 'critical'
  createdAt: number
  expiresAt?: number
}

export class CrossSolverEvidenceBus {
  private messages: SolverEvidenceMessage[] = []
  private cursors = new Map<string, SolverEvidenceCursor>()
  private readonly maxMessages: number

  constructor(maxMessages = 200) {
    this.maxMessages = maxMessages
  }

  public publish(msg: SolverEvidenceMessage): void {
    // Deduplicate by message ID or summary
    if (this.messages.some((m) => m.id === msg.id || m.summary === msg.summary)) {
      return
    }

    if (this.messages.length >= this.maxMessages) {
      this.messages.shift()
    }
    this.messages.push(msg)
  }

  public getUnreadMessages(
    solverRunId: string,
    currentRevision: number,
    limit = 5,
  ): SolverEvidenceMessage[] {
    let cursor = this.cursors.get(solverRunId)
    if (!cursor) {
      cursor = { solverRunId, lastSeenStateRevision: 0 }
      this.cursors.set(solverRunId, cursor)
    }

    const unread = this.messages.filter(
      (m) =>
        m.sourceSolverRunId !== solverRunId &&
        (!m.expiresAt || m.expiresAt > Date.now()),
    )

    // Sort by priority
    const priorityWeight = { critical: 4, high: 3, normal: 2, low: 1 }
    unread.sort((a, b) => priorityWeight[b.priority] - priorityWeight[a.priority])

    const selected = unread.slice(0, limit)
    cursor.lastSeenStateRevision = currentRevision

    return selected
  }

  public clear(): void {
    this.messages = []
    this.cursors.clear()
  }
}
