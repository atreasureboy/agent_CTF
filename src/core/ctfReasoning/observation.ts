/**
 * Observation — Phase 2.1 §四.
 *
 * A single observation produced by some execution system (tool /
 * workflow / oneshot / agent / specialist). An Observation is a fact
 * witnessed by a Source, not a finalised conclusion. Multiple
 * Observations can be merged into a single Evidence claim by the
 * ResultMaterializer.
 *
 * Invariants (enforced by `createObservation`):
 *   - `confidence` ∈ [0, 1]
 *   - `taskId` is non-empty
 *   - `source.type` is set
 *   - `rawExcerpt` is bounded by `MAX_RAW_EXCERPT`
 */

import { randomBytes } from 'crypto'

export const MAX_RAW_EXCERPT = 1024

export type ObservationKind =
  | 'file_type'
  | 'file_magic'
  | 'metadata'
  | 'embedded_data'
  | 'printable_text'
  | 'encoding_result'
  | 'archive_entry'
  | 'image_property'
  | 'binary_protection'
  | 'tool_availability'
  | 'command_status'
  | 'network_service'
  | 'flag_like_text'
  | 'negative_result'
  | 'generic'

export type ObservationSourceType =
  'tool' | 'workflow' | 'oneshot' | 'agent' | 'specialist' | 'manual'

export interface ObservationSource {
  type: ObservationSourceType
  toolId?: string
  workflowId?: string
  workflowRunId?: string
  stepId?: string
  oneShotRunId?: string
  agentRunId?: string
  handoffId?: string
  artifactId?: string
}

export interface Observation {
  id: string
  taskId: string
  kind: ObservationKind
  source: ObservationSource
  summary: string
  attributes: Record<string, unknown>
  rawExcerpt?: string
  confidence: number
  /** §六 — the Attempt id that produced this Observation. */
  attemptId?: string
  createdAt: number
}

export interface ObservationDraft {
  kind: ObservationKind
  source: ObservationSource
  summary: string
  attributes?: Record<string, unknown>
  rawExcerpt?: string
  confidence: number
  /** §六 — populated by MaterializationContext before createObservation. */
  attemptId?: string
}

/** Build a fully-formed Observation from a draft. Throws on invariant
 *  violation. */
export function createObservation(taskId: string, draft: ObservationDraft): Observation {
  if (!taskId) throw new Error('createObservation: taskId is required')
  if (!draft.source || !draft.source.type) {
    throw new Error('createObservation: source.type is required')
  }
  if (draft.confidence < 0 || draft.confidence > 1 || !Number.isFinite(draft.confidence)) {
    throw new Error(`createObservation: confidence must be in [0, 1], got ${draft.confidence}`)
  }
  if (!draft.summary) {
    throw new Error('createObservation: summary is required')
  }
  const id = `obs_${randomBytes(6).toString('hex')}`
  const rawExcerpt =
    draft.rawExcerpt && draft.rawExcerpt.length > MAX_RAW_EXCERPT
      ? draft.rawExcerpt.slice(0, MAX_RAW_EXCERPT)
      : draft.rawExcerpt
  return {
    id,
    taskId,
    kind: draft.kind,
    source: draft.source,
    summary: draft.summary,
    attributes: draft.attributes ?? {},
    rawExcerpt,
    confidence: draft.confidence,
    attemptId: draft.attemptId,
    createdAt: Date.now(),
  }
}

/** Stable fingerprint for Observation de-duplication. Same Kind + same
 *  source identity + same summary + same attributes → identical
 *  fingerprint. */
export function observationFingerprint(
  o: Pick<Observation, 'kind' | 'source' | 'summary' | 'attributes'>,
): string {
  const sourceId = `${o.source.type}:${o.source.toolId ?? ''}:${o.source.workflowId ?? ''}:${o.source.stepId ?? ''}:${o.source.oneShotRunId ?? ''}:${o.source.artifactId ?? ''}`
  const attrKey = Object.keys(o.attributes)
    .sort()
    .map((k) => `${k}=${JSON.stringify(o.attributes[k])}`)
    .join('|')
  return `${o.kind}|${sourceId}|${o.summary}|${attrKey}`
}
