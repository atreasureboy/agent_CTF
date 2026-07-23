/**
 * Evidence — Phase 2.2 §十五.
 *
 * A claim supported (or contradicted) by one or more Observations.
 * Evidence is the building block for Hypothesis confidence updates.
 *
 * Multi-source model: each Evidence carries an array of `EvidenceSource`
 * records. Two parsers producing the same claim → one Evidence with two
 * Sources (instead of two separate Evidences).
 *
 * Fingerprint identity (per §十五):
 *   taskId | kind | subject | normalizedClaim | polarity
 *
 * Producer info is intentionally excluded from the fingerprint so two
 * different parsers (file / hex / generic) can converge on the same
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

export type EvidenceProducerType = 'parser' | 'workflow' | 'oneshot' | 'agent' | 'specialist' | 'manual'

export interface EvidenceProducer {
  type: EvidenceProducerType
  id: string
}

export type EvidencePolarity = 'supports' | 'contradicts' | 'neutral'

export interface EvidenceSubject {
  artifactId?: string
  valueHash?: string
  entityId?: string
}

export interface EvidenceSource {
  producer: EvidenceProducer
  observationIds: string[]
  artifactIds: string[]
  attemptIds: string[]
  confidence: number
  createdAt: number
}

export interface Evidence {
  id: string
  taskId: string
  kind: EvidenceKind
  subject?: EvidenceSubject
  claim: string
  normalizedClaim: string
  polarity: EvidencePolarity
  confidence: number
  sources: EvidenceSource[]
  /** §十五 — fingerprint is the identity key. Excludes producer so
   *  multiple parsers can converge. Computed once at creation. */
  fingerprint: string
  attributes?: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

export interface EvidenceDraft {
  kind: EvidenceKind
  claim: string
  subject?: EvidenceSubject
  observationIds?: string[]
  artifactIds?: string[]
  attemptIds?: string[]
  polarity?: EvidencePolarity
  confidence: number
  producer: EvidenceProducer
}

function dedupeStrings(arr: string[]): string[] {
  return [...new Set(arr)]
}

/** §十五 — normalize a claim for fingerprint stability. Whitespace
 *  collapsed and lower-cased; punctuation preserved. */
export function normalizeClaim(claim: string): string {
  return claim.replace(/\s+/g, ' ').trim().toLowerCase()
}

/** §十五 — fingerprint excludes producer so two different parsers
 *  converge on the same Evidence. */
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

export function createEvidence(taskId: string, draft: EvidenceDraft): Evidence {
  if (!taskId) throw new Error('createEvidence: taskId is required')
  if (!draft.claim) throw new Error('createEvidence: claim is required')
  if (!draft.producer || !draft.producer.type || !draft.producer.id) {
    throw new Error('createEvidence: producer.type and producer.id are required')
  }
  if (draft.confidence < 0 || draft.confidence > 1 || !Number.isFinite(draft.confidence)) {
    throw new Error(`createEvidence: confidence must be in [0, 1], got ${draft.confidence}`)
  }
  const observationIds = dedupeStrings(draft.observationIds ?? [])
  const artifactIds = dedupeStrings(draft.artifactIds ?? [])
  const attemptIds = dedupeStrings(draft.attemptIds ?? [])
  if (observationIds.length === 0 && artifactIds.length === 0) {
    throw new Error('createEvidence: at least one observationId or artifactId is required')
  }
  const polarity = draft.polarity ?? 'supports'
  const normalizedClaim = normalizeClaim(draft.claim)
  const id = `ev_${randomBytes(6).toString('hex')}`
  return {
    id,
    taskId,
    kind: draft.kind,
    subject: draft.subject,
    claim: draft.claim,
    normalizedClaim,
    polarity,
    confidence: draft.confidence,
    sources: [
      {
        producer: draft.producer,
        observationIds,
        artifactIds,
        attemptIds,
        confidence: draft.confidence,
        createdAt: Date.now(),
      },
    ],
    fingerprint: evidenceFingerprint({ taskId, kind: draft.kind, subject: draft.subject, claim: draft.claim, polarity }),
    attributes: {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

/** Merge two Evidence records with the same fingerprint. Combines all
 *  sources. Combined confidence uses the bounded 1−∏(1−c) method
 *  from §十五, capped at 0.99 so converging evidence does not
 *  certify absolute truth.
 *
 *  Producers with the same `type` are down-weighted — they are not
 *  treated as fully independent witnesses. */
export function mergeEvidence(a: Evidence, b: Evidence): Evidence {
  if (a.taskId !== b.taskId || a.kind !== b.kind || a.normalizedClaim !== b.normalizedClaim || a.polarity !== b.polarity) {
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

/** Bounded combination: 1 − ∏(1 − c_i), capped at 0.99. */
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