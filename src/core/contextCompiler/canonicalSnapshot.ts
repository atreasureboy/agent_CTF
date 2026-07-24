import { createHash } from 'crypto'

export interface ContextSnapshotSource {
  taskId: string
  stateRevision: number

  evidence: Array<{
    id: string
    confidence: number
    polarity?: string
    sourceIds?: string[]
  }>

  hypotheses: Array<{
    id: string
    status: string
    confidence?: number
  }>

  attempts: Array<{
    id: string
    status: string
    fingerprint: string
  }>

  artifacts: Array<{
    id: string
    sha256?: string
    size?: number
  }>

  pendingActions: Array<{
    id: string
    status: string
  }>

  toolExposureHash: string
  compilerVersion: string
}

function stableStringify(obj: any): string {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj)
  }
  if (Array.isArray(obj)) {
    return '[' + obj.map(stableStringify).join(',') + ']'
  }
  const keys = Object.keys(obj).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}'
}

export function computeCanonicalSnapshotHash(source: ContextSnapshotSource): string {
  const normalized = {
    taskId: source.taskId,
    stateRevision: source.stateRevision,
    evidence: [...source.evidence].sort((a, b) => a.id.localeCompare(b.id)),
    hypotheses: [...source.hypotheses].sort((a, b) => a.id.localeCompare(b.id)),
    attempts: [...source.attempts].sort((a, b) => a.id.localeCompare(b.id)),
    artifacts: [...source.artifacts].sort((a, b) => a.id.localeCompare(b.id)),
    pendingActions: [...source.pendingActions].sort((a, b) => a.id.localeCompare(b.id)),
    toolExposureHash: source.toolExposureHash,
    compilerVersion: source.compilerVersion,
  }

  const json = stableStringify(normalized)
  return createHash('sha256').update(json).digest('hex')
}
