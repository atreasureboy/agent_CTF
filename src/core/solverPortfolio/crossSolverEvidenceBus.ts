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
  private messages: SolverEvidenceMessage[] = []
  private cursors = new Map<string, SolverEvidenceCursor>()
  private readonly maxMessages: number

  constructor(maxMessages = 200) {
    this.maxMessages = maxMessages
  }

  private buildDedupKey(msg: SolverEvidenceMessage): string {
    const evs = (msg.evidenceIds || []).sort().join(',')
    return `${msg.taskId}:${msg.sourceSolverRunId}:${msg.stateRevision || 0}:${evs}:${msg.summary}`
  }

  public publish(msg: SolverEvidenceMessage): void {
    const key = this.buildDedupKey(msg)
    if (this.messages.some((m) => this.buildDedupKey(m) === key || m.id === msg.id)) {
      return
    }

    if (this.messages.length >= this.maxMessages) {
      this.messages.shift()
    }
    this.messages.push(msg)
  }

  public getUnreadMessages(
    taskId: string,
    solverRunId: string,
    currentRevision: number,
    limit = 5,
  ): SolverEvidenceMessage[] {
    let cursor = this.cursors.get(solverRunId)
    if (!cursor) {
      cursor = { solverRunId, lastSeenStateRevision: 0, seenMessageIds: new Set<string>() }
      this.cursors.set(solverRunId, cursor)
    }

    const unread = this.messages.filter(
      (m) =>
        m.taskId === taskId &&
        m.sourceSolverRunId !== solverRunId &&
        !cursor!.seenMessageIds.has(m.id) &&
        (!m.expiresAt || m.expiresAt > Date.now()),
    )

    const priorityWeight = { critical: 4, high: 3, normal: 2, low: 1 }
    unread.sort((a, b) => priorityWeight[b.priority] - priorityWeight[a.priority])

    const selected = unread.slice(0, limit)
    for (const m of selected) {
      cursor.seenMessageIds.add(m.id)
    }
    cursor.lastSeenStateRevision = currentRevision

    return selected
  }

  public dispose(): void {
    this.messages = []
    this.cursors.clear()
  }

  public clear(): void {
    this.dispose()
  }
}
