/**
 * ResultMerger — Phase 2.2 §十六.
 *
 * Unifies observations, evidence, suggested actions, and flag
 * candidates produced by multiple parsers / materializers into a
 * single coherent `MaterializedResult`.
 *
 * The merger:
 *   - Dedupes observations by fingerprint, keeping the highest
 *     confidence.
 *   - Merges evidence with the same identity (taskId + kind +
 *     subject + normalizedClaim + polarity) using bounded confidence
 *     combination. Sources from both records are preserved.
 *   - Dedupes suggested actions by (type, targetId, fingerprint of
 *     normalized input + artifact ids + hypothesis ids). When
 *     deduped, priority = max, reason = union, costTier = higher
 *     cost, hypothesisIds = union.
 *   - Merges flag candidates by `normalizedValue`, concatenating
 *     sourceObservationIds / sourceEvidenceIds / sourceArtifactIds
 *     and union of transformChain entries.
 *
 * Pure: returns a new MaterializedResult, never mutates inputs.
 */

import { createHash } from 'crypto'
import type { ObservationDraft } from './observation.js'
import type {
  Evidence,
  EvidenceDraft,
} from './evidence.js'
import { combineIndependentConfidences } from './evidence.js'
import type { SuggestedAction, CostTier } from './suggestedAction.js'
import type { FlagCandidateDraft } from './flagCandidate.js'
import type { MaterializedResult } from './parserRegistry.js'

function fingerprintObservation(o: ObservationDraft): string {
  const sourceId = `${o.source.type}:${o.source.toolId ?? ''}:${o.source.workflowId ?? ''}:${o.source.stepId ?? ''}:${o.source.oneShotRunId ?? ''}:${o.source.artifactId ?? ''}`
  const attrKey = Object.keys(o.attributes ?? {})
    .sort()
    .map((k) => `${k}=${JSON.stringify((o.attributes ?? {})[k])}`)
    .join('|')
  return `${o.kind}|${sourceId}|${o.summary}|${attrKey}`
}

function fingerprintEvidence(e: EvidenceDraft | Evidence): string {
  const subj = 'subject' in e ? e.subject : undefined
  const subjectKey = subj
    ? `${subj.artifactId ?? ''}|${subj.valueHash ?? ''}|${subj.entityId ?? ''}`
    : ''
  const normalized = (e.claim ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
  const taskId = (e as { taskId?: string }).taskId ?? ''
  return `${taskId}|${e.kind}|${subjectKey}|${normalized}|${e.polarity ?? 'supports'}`
}

function fingerprintAction(a: SuggestedAction): string {
  const payload = {
    type: a.type,
    targetId: actionTargetId(a),
    input: stableJson(actionInput(a)),
    artifactIds: actionArtifactIds(a).slice().sort(),
    hypothesisIds: (a.hypothesisIds ?? []).slice().sort(),
  }
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

function actionTargetId(a: SuggestedAction): string {
  switch (a.type) {
    case 'run_workflow': return a.workflowId
    case 'run_oneshot': return a.manifestId
    case 'call_tool': return a.toolId
    case 'request_handoff': return a.capability
    case 'verify_flag': return a.candidateId
    case 'stop': return 'stop'
  }
}

function actionInput(a: SuggestedAction): unknown {
  switch (a.type) {
    case 'run_workflow': return { inputs: a.inputs }
    case 'run_oneshot': return { options: a.options ?? {}, inputArtifactIds: a.inputArtifactIds.slice().sort() }
    case 'call_tool': return { input: a.input }
    case 'request_handoff': return { capability: a.capability, objective: a.objective }
    case 'verify_flag': return { candidateId: a.candidateId }
    case 'stop': return {}
  }
}

function actionArtifactIds(a: SuggestedAction): string[] {
  switch (a.type) {
    case 'run_workflow': return []
    case 'run_oneshot': return a.inputArtifactIds
    case 'call_tool': return []
    case 'request_handoff': return a.artifactIds
    case 'verify_flag': return []
    case 'stop': return []
  }
}

function stableJson(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`
  const keys = Object.keys(v as Record<string, unknown>).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`).join(',')}}`
}

const COST_TIER_RANK: Record<CostTier, number> = { cheap: 0, normal: 1, expensive: 2 }
function higherCost(a: CostTier, b: CostTier): CostTier {
  return COST_TIER_RANK[a] >= COST_TIER_RANK[b] ? a : b
}

export interface ResultMerger {
  merge(results: ReadonlyArray<MaterializedResult>): MaterializedResult
}

export function createResultMerger(): ResultMerger {
  return {
    merge(results) {
      const observations: ObservationDraft[] = []
      const obsByKey = new Map<string, ObservationDraft>()
      const evidence: EvidenceDraft[] = []
      const evByKey = new Map<string, EvidenceDraft>()
      const suggestedActions: SuggestedAction[] = []
      const actByKey = new Map<string, SuggestedAction>()
      const flagCandidateDrafts: FlagCandidateDraft[] = []
      const fcByKey = new Map<string, FlagCandidateDraft>()
      const warnings: string[] = []
      const seenWarn = new Set<string>()
      const rawArtifactIds: string[] = []
      const seenArtifact = new Set<string>()

      for (const r of results) {
        for (const o of r.observations) {
          const k = fingerprintObservation(o)
          const existing = obsByKey.get(k)
          if (!existing) {
            obsByKey.set(k, o)
          } else if (o.confidence > existing.confidence) {
            obsByKey.set(k, o)
          }
        }
        for (const e of r.evidence) {
          const k = fingerprintEvidence(e)
          const existing = evByKey.get(k)
          if (!existing) {
            evByKey.set(k, e)
          } else {
            // Bounded confidence combination; keep the stronger claim
            // wording and the more complete producer.
            const combined = combineIndependentConfidences([
              { producer: existing.producer, observationIds: [], artifactIds: [], attemptIds: [], confidence: existing.confidence, createdAt: 0 },
              { producer: e.producer, observationIds: [], artifactIds: [], attemptIds: [], confidence: e.confidence, createdAt: 0 },
            ])
            evByKey.set(k, {
              ...existing,
              confidence: combined,
              // Keep both observation / artifact references
              observationIds: dedupe([...(existing.observationIds ?? []), ...(e.observationIds ?? [])]),
              artifactIds: dedupe([...(existing.artifactIds ?? []), ...(e.artifactIds ?? [])]),
              attemptIds: dedupe([...(existing.attemptIds ?? []), ...(e.attemptIds ?? [])]),
            })
          }
        }
        for (const a of r.suggestedActions) {
          const k = fingerprintAction(a)
          const existing = actByKey.get(k)
          if (!existing) {
            actByKey.set(k, a)
          } else {
            const merged: SuggestedAction = mergeActions(existing, a)
            actByKey.set(k, merged)
          }
        }
        for (const c of r.flagCandidateDrafts) {
          const k = c.normalizedValue
          const existing = fcByKey.get(k)
          if (!existing) {
            fcByKey.set(k, c)
          } else {
            fcByKey.set(k, mergeCandidateDrafts(existing, c))
          }
        }
        for (const w of r.warnings) {
          if (!seenWarn.has(w)) {
            seenWarn.add(w)
            warnings.push(w)
          }
        }
        for (const a of r.rawArtifactIds ?? []) {
          if (!seenArtifact.has(a)) {
            seenArtifact.add(a)
            rawArtifactIds.push(a)
          }
        }
      }

      for (const o of obsByKey.values()) observations.push(o)
      for (const e of evByKey.values()) evidence.push(e)
      for (const a of actByKey.values()) suggestedActions.push(a)
      for (const c of fcByKey.values()) flagCandidateDrafts.push(c)

      return {
        observations,
        evidence,
        suggestedActions,
        flagCandidateDrafts,
        warnings,
        rawArtifactIds,
      }
    },
  }
}

function mergeActions(a: SuggestedAction, b: SuggestedAction): SuggestedAction {
  const priority = Math.max(a.priority, b.priority)
  const costTier = higherCost(a.costTier, b.costTier)
  const reason = uniqueReasons(a.reason, b.reason)
  const hypothesisIds = dedupe([...(a.hypothesisIds ?? []), ...(b.hypothesisIds ?? [])])
  return { ...a, priority, costTier, reason, hypothesisIds } as SuggestedAction
}

function uniqueReasons(a: string, b: string): string {
  if (a === b) return a
  return `${a}; ${b}`
}

function mergeCandidateDrafts(a: FlagCandidateDraft, b: FlagCandidateDraft): FlagCandidateDraft {
  const sourceObservationIds = dedupe([...a.sourceObservationIds, ...b.sourceObservationIds])
  const sourceEvidenceIds = dedupe([...a.sourceEvidenceIds, ...b.sourceEvidenceIds])
  const sourceArtifactIds = dedupe([...a.sourceArtifactIds, ...b.sourceArtifactIds])
  const sourceRunIds = dedupe([...a.sourceRunIds, ...b.sourceRunIds])
  const transformChain = [...(a.transformChain ?? []), ...(b.transformChain ?? [])]
  const confidence = Math.max(a.confidence, b.confidence)
  return {
    value: a.value,
    normalizedValue: a.normalizedValue,
    sourceObservationIds,
    sourceEvidenceIds,
    sourceArtifactIds,
    sourceRunIds,
    transformChain,
    confidence,
    producer: a.producer,
  }
}

function dedupe<T>(arr: T[]): T[] {
  return [...new Set(arr)]
}