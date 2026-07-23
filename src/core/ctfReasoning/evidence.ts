/**
 * Evidence — Phase 2.1 §五.
 *
 * A claim supported (or contradicted) by one or more Observations.
 * Evidence has a stable fingerprint for de-duplication and is the
 * building block for Hypothesis confidence updates.
 *
 * Invariants (enforced by `createEvidence`):
 *   - must reference ≥ 1 Observation or Artifact
 *   - must have a producer
 *   - confidence ∈ [0, 1]
 *   - same claim + same polarity + same producer id → identical
 *     fingerprint (deduped by `mergeEvidence`).
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

export interface Evidence {
  id: string
  taskId: string
  kind: EvidenceKind
  claim: string
  observationIds: string[]
  artifactIds: string[]
  polarity: EvidencePolarity
  confidence: number
  producer: EvidenceProducer
  /** Hash of (kind|claim|producer) used for de-dup. */
  fingerprint: string
  createdAt: number
}

export interface EvidenceDraft {
  kind: EvidenceKind
  claim: string
  observationIds?: string[]
  artifactIds?: string[]
  polarity?: EvidencePolarity
  confidence: number
  producer: EvidenceProducer
}

export function evidenceFingerprint(e: Pick<EvidenceDraft, 'kind' | 'claim' | 'producer'>): string {
  return createHash('sha256')
    .update(`${e.kind}|${e.producer.type}:${e.producer.id}|${e.claim}`)
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
  if (observationIds.length === 0 && artifactIds.length === 0) {
    throw new Error('createEvidence: at least one observationId or artifactId is required')
  }
  return {
    id: `ev_${randomBytes(6).toString('hex')}`,
    taskId,
    kind: draft.kind,
    claim: draft.claim,
    observationIds,
    artifactIds,
    polarity: draft.polarity ?? 'supports',
    confidence: draft.confidence,
    producer: draft.producer,
    fingerprint: evidenceFingerprint(draft),
    createdAt: Date.now(),
  }
}

function dedupeStrings(arr: string[]): string[] {
  return [...new Set(arr)]
}

/** Merge two Evidence records with the same fingerprint. The merged
 *  record's observationIds + artifactIds are the union, and confidence
 *  is the max of the two. */
export function mergeEvidence(a: Evidence, b: Evidence): Evidence {
  if (a.fingerprint !== b.fingerprint) {
    throw new Error('mergeEvidence: fingerprint mismatch')
  }
  return {
    ...a,
    observationIds: dedupeStrings([...a.observationIds, ...b.observationIds]),
    artifactIds: dedupeStrings([...a.artifactIds, ...b.artifactIds]),
    confidence: Math.max(a.confidence, b.confidence),
  }
}