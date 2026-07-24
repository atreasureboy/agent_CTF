/**
 * Evidence — Phase 2.3 §十三, §十四.
 *
 * Multi-source, identity-stable Evidence. Each Evidence carries a
 * `sources: EvidenceSource[]` array; `EVIDENCE_UPSERTED` (or
 * `store.upsertEvidence`) atomically adds/migrates a source into an
 * Evidence whose fingerprint already exists.
 *
 * Fingerprint identity (per §十五):
 *   taskId | kind | subject | normalizedClaim | polarity
 *
 * Producer info is intentionally excluded from the fingerprint so two
 * different parsers (file / hex / generic) converge on the same
 * Evidence.
 */

import { createHash, randomBytes } from 'crypto'

export type EvidenceKind =
  | 'file_signature'
  | 'extension_mismatch'
  | 'embedded_archive'
  | 'suspicious_metadata'
  | 'encoding_decoded'
  | 'encoding_layer'
  | 'known_magic'
  | 'binary_protection'
  | 'flag_candidate_source'
  | 'tool_failure'
  | 'tool_unavailable'
  | 'negative_result'
  | 'generic'

export type EvidenceProducerType =
  'parser' | 'workflow' | 'oneshot' | 'agent' | 'specialist' | 'manual'

export interface EvidenceProducer {
  type: EvidenceProducerType
  id: string
}

export type EvidencePolarity = 'supports' | 'contradicts' | 'neutral'

/** §十五 — semantic Claim Family. The conflict resolver uses this
 *  to group Evidence into conflict groups. */
export type EvidenceClaimFamily =
  | 'file_type'
  | 'archive_type'
  | 'encoding_type'
  | 'binary_arch'
  | 'flag_value'
  | 'network_service'
  | 'generic'

export interface EvidenceSubject {
  artifactId?: string
  valueHash?: string
  entityId?: string
}

export interface EvidenceSourceDraft {
  producer: EvidenceProducer
  observationIds: string[]
  artifactIds: string[]
  attemptIds: string[]
  confidence: number
  createdAt: number
}

export interface EvidenceSource extends EvidenceSourceDraft {}

export interface Evidence {
  id: string
  taskId: string
  kind: EvidenceKind
  /** §十五 — for `ParserConflictResolver` grouping. */
  claimFamily: EvidenceClaimFamily
  subject?: EvidenceSubject
  claim: string
  normalizedClaim: string
  polarity: EvidencePolarity
  confidence: number
  sources: EvidenceSource[]
  fingerprint: string
  attributes?: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

/** Multi-source draft. Each Parser/Executor emits one Source; the
 *  store's `upsertEvidence` merges them into the canonical Evidence. */
export interface EvidenceDraft {
  kind: EvidenceKind
  claimFamily?: EvidenceClaimFamily
  subject?: EvidenceSubject
  claim: string
  polarity?: EvidencePolarity
  /** Single producer for the source this draft represents. The
   *  store upserts this source into the Evidence matching the
   *  fingerprint. */
  source: EvidenceSourceDraft
}

function dedupeStrings(arr: string[]): string[] {
  return [...new Set(arr)]
}

export function normalizeClaim(claim: string): string {
  return claim.replace(/\s+/g, ' ').trim().toLowerCase()
}

export function evidenceFingerprint(e: {
  taskId: string
  kind: EvidenceKind
  subject?: EvidenceSubject
  claim: string
  polarity: EvidencePolarity
}): string {
  const subjectKey = e.subject
    ? `${e.subject.artifactId ?? ''}|${e.subject.valueHash ?? ''}|${e.subject.entityId ?? ''}`
    : ''
  const normalized = normalizeClaim(e.claim)
  return createHash('sha256')
    .update(`${e.taskId}|${e.kind}|${subjectKey}|${normalized}|${e.polarity}`)
    .digest('hex')
}

export function deriveClaimFamilyFromKind(kind: EvidenceKind): EvidenceClaimFamily {
  switch (kind) {
    case 'file_signature':
    case 'known_magic':
      return 'file_type'
    case 'embedded_archive':
      return 'archive_type'
    case 'encoding_decoded':
    case 'encoding_layer':
      return 'encoding_type'
    case 'binary_protection':
      return 'binary_arch'
    case 'flag_candidate_source':
      return 'flag_value'
    default:
      return 'generic'
  }
}

export function createEvidence(taskId: string, draft: EvidenceDraft): Evidence {
  if (!taskId) throw new Error('createEvidence: taskId is required')
  if (!draft.claim) throw new Error('createEvidence: claim is required')
  if (!draft.source.producer.type || !draft.source.producer.id) {
    throw new Error('createEvidence: source.producer.type and source.producer.id are required')
  }
  if (
    draft.source.confidence < 0 ||
    draft.source.confidence > 1 ||
    !Number.isFinite(draft.source.confidence)
  ) {
    throw new Error(
      `createEvidence: source confidence must be in [0, 1], got ${draft.source.confidence}`,
    )
  }
  const source = draft.source
  const fingerprint = evidenceFingerprint({
    taskId,
    kind: draft.kind,
    subject: draft.subject,
    claim: draft.claim,
    polarity: draft.polarity ?? 'supports',
  })
  const id = `ev_${fingerprint.slice(0, 16)}`
  const normalizedClaim = normalizeClaim(draft.claim)
  return {
    id,
    taskId,
    kind: draft.kind,
    claimFamily: draft.claimFamily ?? deriveClaimFamilyFromKind(draft.kind),
    subject: draft.subject,
    claim: draft.claim,
    normalizedClaim,
    polarity: draft.polarity ?? 'supports',
    confidence: source.confidence,
    sources: [{ ...source, createdAt: source.createdAt || Date.now() }],
    fingerprint,
    attributes: {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

export function mergeEvidence(a: Evidence, b: Evidence): Evidence {
  if (
    a.taskId !== b.taskId ||
    a.kind !== b.kind ||
    a.normalizedClaim !== b.normalizedClaim ||
    a.polarity !== b.polarity
  ) {
    throw new Error('mergeEvidence: fingerprint mismatch')
  }
  const sources = [...a.sources, ...b.sources]
  const combined = combineIndependentConfidences(sources)
  return {
    ...a,
    subject: a.subject ?? b.subject,
    sources,
    confidence: combined,
    updatedAt: Date.now(),
  }
}

export function combineIndependentConfidences(sources: ReadonlyArray<EvidenceSource>): number {
  if (sources.length === 0) return 0
  let p = 1
  for (const s of sources) {
    p *= 1 - clamp01(s.confidence)
  }
  const combined = 1 - p
  return Math.min(0.99, Math.max(0, combined))
}

function clamp01(v: number): number {
  if (Number.isNaN(v) || !Number.isFinite(v)) return 0
  if (v < 0) return 0
  if (v > 1) return 1
  return v
}
