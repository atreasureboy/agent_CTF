/**
 * ResultMerger — Phase 2.3 §十四, §十六.
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
 *     combination. Sources from both records are preserved (no
 *     producer loss).
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
  EvidenceClaimFamily,
  EvidenceDraft,
  EvidenceSourceDraft,
} from './evidence.js'
import {
  combineIndependentConfidences,
  deriveClaimFamilyFromKind,
  normalizeClaim,
} from './evidence.js'
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
  const claim = ('claim' in e ? e.claim : '') ?? ''
  const normalized = normalizeClaim(claim)
  const taskId = (e as { taskId?: string }).taskId ?? ''
  const polarity = 'polarity' in e ? (e.polarity ?? 'supports') : 'supports'
  return `${taskId}|${e.kind}|${subjectKey}|${normalized}|${polarity}`
}

function claimFamilyFor(d: EvidenceDraft): EvidenceClaimFamily {
  return d.claimFamily ?? deriveClaimFamilyFromKind(d.kind)
}

/** Convert a single-source EvidenceDraft back into the canonical
 *  `EvidenceSourceDraft` shape that the state store uses. */
export function evidenceDraftToSource(d: EvidenceDraft): EvidenceSourceDraft {
  return {
    producer: d.source.producer,
    observationIds: d.source.observationIds,
    artifactIds: d.source.artifactIds,
    attemptIds: d.source.attemptIds,
    confidence: d.source.confidence,
    createdAt: d.source.createdAt,
  }
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
    case 'run_workflow':
      return a.workflowId
    case 'run_oneshot':
      return a.manifestId
    case 'call_tool':
      return a.toolId
    case 'request_handoff':
      return a.capability
    case 'verify_flag':
      return a.candidateId
    case 'stop':
      return 'stop'
  }
}

function actionInput(a: SuggestedAction): unknown {
  switch (a.type) {
    case 'run_workflow':
      return { inputs: a.inputs }
    case 'run_oneshot':
      return { options: a.options ?? {}, inputArtifactIds: a.inputArtifactIds.slice().sort() }
    case 'call_tool':
      return { input: a.input }
    case 'request_handoff':
      return { capability: a.capability, objective: a.objective }
    case 'verify_flag':
      return { candidateId: a.candidateId }
    case 'stop':
      return {}
  }
}

function actionArtifactIds(a: SuggestedAction): string[] {
  switch (a.type) {
    case 'run_workflow':
      return []
    case 'run_oneshot':
      return a.inputArtifactIds
    case 'call_tool':
      return []
    case 'request_handoff':
      return a.artifactIds
    case 'verify_flag':
      return []
    case 'stop':
      return []
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
            // §十四 — merge Sources from both drafts. We keep both
            // producers so the second parser is not dropped. Each
            // draft carries exactly one source (its own producer).
            const sources = [existing.source, e.source]
            // Bounded confidence combination: pretend the two
            // sources are independent witnesses and combine. The
            // Evidence's confidence is recomputed by the state
            // store's reducer when these are upserted.
            const combined = combineIndependentConfidences(
              sources.map((s) => ({
                producer: s.producer,
                observationIds: [],
                artifactIds: [],
                attemptIds: [],
                confidence: s.confidence,
                createdAt: 0,
              })),
            )
            evByKey.set(k, {
              ...existing,
              claimFamily: existing.claimFamily ?? claimFamilyFor(e),
              source: {
                producer:
                  existing.source.producer.id + ',' + e.source.producer.id ===
                  existing.source.producer.id
                    ? existing.source.producer
                    : {
                        type: existing.source.producer.type,
                        id: 'merged:' + existing.source.producer.id + '+' + e.source.producer.id,
                      },
                observationIds: dedupe([
                  ...(existing.source.observationIds ?? []),
                  ...(e.source.observationIds ?? []),
                ]),
                artifactIds: dedupe([
                  ...(existing.source.artifactIds ?? []),
                  ...(e.source.artifactIds ?? []),
                ]),
                attemptIds: dedupe([
                  ...(existing.source.attemptIds ?? []),
                  ...(e.source.attemptIds ?? []),
                ]),
                confidence: combined,
                createdAt:
                  Math.max(existing.source.createdAt || 0, e.source.createdAt || 0) || Date.now(),
              },
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
