/**
 * HypothesisUpdater — Phase 2.2 §九.
 *
 * Deterministic rules that translate new Observation / Evidence into
 * Hypothesis state changes. No LLM call. Each rule describes one
 * category of evidence and the matching hypothesis update.
 *
 * Categories:
 *   - file_signature (PNG / ZIP / ELF)   →  propose "file is <format>"
 *   - extension_mismatch                 →  propose "extension lies"
 *   - embedded_archive                   →  propose "file embeds archive"
 *   - suspicious_metadata               →  propose "metadata carries text"
 *   - encoding_layer / encoding_decoded →  propose "input has codec layer"
 *   - negative_result (zsteg)            →  weaken existing "image hides data" h.
 *   - flag_candidate_source             →  propose "candidate source found"
 *
 * No rule creates a "solved" hypothesis — the orchestrator decides.
 */

import type { CTFTaskState } from '../ctfRuntime/taskState.js'
import type { CTFHypothesis } from '../ctfRuntime/taskState.js'
import type { Evidence } from './evidence.js'
import { randomBytes } from 'crypto'

export interface HypothesisUpdateInput {
  state: Readonly<CTFTaskState>
  newObservationIds: string[]
  newEvidenceIds: string[]
}

export interface HypothesisUpdate {
  hypothesisId: string
  status?: CTFHypothesis['status']
  supportingEvidenceIds?: string[]
  contradictingEvidenceIds?: string[]
  confidence?: number
}

export interface HypothesisUpdateResult {
  proposed: CTFHypothesis[]
  updates: HypothesisUpdate[]
}

export interface HypothesisUpdater {
  update(input: HypothesisUpdateInput): HypothesisUpdateResult
}

export function createHypothesisUpdater(): HypothesisUpdater {
  return {
    update({ state, newObservationIds, newEvidenceIds }) {
      const evidenceById = new Map(state.evidence.map((e) => [e.id, e]))
      const newEvidence = newEvidenceIds
        .map((id) => evidenceById.get(id))
        .filter((e): e is Evidence => !!e)
      const obs = state.observations.filter((o) => newObservationIds.includes(o.id))

      const proposed: CTFHypothesis[] = []
      const updates: HypothesisUpdate[] = []
      const seenStatements = new Set(
        state.hypotheses.map((h) => `${h.category}|${h.statement}`),
      )

      for (const e of newEvidence) {
        const rule = ruleFor(e, obs)
        if (!rule) continue
        const statementKey = `${rule.category}|${rule.statement}`
        if (seenStatements.has(statementKey)) {
          const existing = state.hypotheses.find(
            (h) => h.category === rule.category && h.statement === rule.statement,
          )
          if (existing) {
            const support = e.polarity === 'supports'
            const update: HypothesisUpdate = {
              hypothesisId: existing.id,
              confidence: support
                ? clamp01(existing.confidence + e.confidence * 0.2)
                : clamp01(existing.confidence - e.confidence * 0.15),
            }
            if (support) {
              update.supportingEvidenceIds = dedupe([
                ...existing.supportingEvidenceIds,
                e.id,
              ])
            } else {
              update.contradictingEvidenceIds = dedupe([
                ...existing.contradictingEvidenceIds,
                e.id,
              ])
            }
            updates.push(update)
          }
          continue
        }
        const hypothesis: CTFHypothesis = {
          id: `hyp_${randomBytes(6).toString('hex')}`,
          taskId: state.taskId,
          statement: rule.statement,
          category: rule.category,
          status: rule.proposedStatus,
          supportingEvidenceIds: e.polarity === 'supports' ? [e.id] : [],
          contradictingEvidenceIds: e.polarity === 'contradicts' ? [e.id] : [],
          proposedBy: { type: 'planner', id: 'hypothesis-updater' },
          priority: rule.priority,
          confidence: e.confidence,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }
        proposed.push(hypothesis)
        seenStatements.add(statementKey)
      }

      // Negative result rule: weaken all "image hides data" hypotheses.
      for (const e of newEvidence) {
        if (e.kind !== 'negative_result' || e.polarity !== 'contradicts') continue
        const stmt = (e.attributes?.['statement'] as string | undefined) ?? ''
        if (!stmt.includes('zsteg') && !stmt.includes('stego')) continue
        for (const h of state.hypotheses) {
          if (h.category !== 'image-stego') continue
          if (h.status === 'rejected' || h.status === 'supported') continue
          updates.push({
            hypothesisId: h.id,
            status: 'inconclusive',
            contradictingEvidenceIds: dedupe([...h.contradictingEvidenceIds, e.id]),
            confidence: clamp01(h.confidence * 0.6),
          })
        }
      }

      return { proposed, updates }
    },
  }
}

interface Rule {
  category: string
  statement: string
  priority: number
  proposedStatus: CTFHypothesis['status']
}

function ruleFor(e: Evidence, obs: ReadonlyArray<{ summary: string; attributes: Record<string, unknown> }>): Rule | undefined {
  const claim = (e.claim ?? '').toLowerCase()
  switch (e.kind) {
    case 'file_signature':
      return {
        category: 'file-type',
        statement: `file is ${claim.replace(/^file is\s+/, '').trim()}`,
        priority: 5,
        proposedStatus: 'proposed',
      }
    case 'extension_mismatch':
      return {
        category: 'extension-mismatch',
        statement: 'file extension does not match real type',
        priority: 6,
        proposedStatus: 'proposed',
      }
    case 'embedded_archive':
      return {
        category: 'embedded',
        statement: 'file embeds an archive',
        priority: 4,
        proposedStatus: 'proposed',
      }
    case 'suspicious_metadata':
      return {
        category: 'metadata',
        statement: 'metadata contains suspicious text',
        priority: 3,
        proposedStatus: 'proposed',
      }
    case 'encoding_layer':
      return {
        category: 'encoding',
        statement: 'input is some encoding layer',
        priority: 3,
        proposedStatus: 'proposed',
      }
    case 'encoding_decoded':
      return {
        category: 'encoding-decoded',
        statement: 'one decoding layer succeeded',
        priority: 4,
        proposedStatus: 'proposed',
      }
    case 'negative_result': {
      if (claim.includes('zsteg') || claim.includes('stego')) {
        return {
          category: 'image-stego',
          statement: 'image has steganography payload',
          priority: 4,
          proposedStatus: 'proposed',
        }
      }
      return undefined
    }
    case 'flag_candidate_source':
      return {
        category: 'flag-source',
        statement: 'candidate flag source identified',
        priority: 9,
        proposedStatus: 'testing',
      }
    default:
      return undefined
  }
}

function dedupe<T>(arr: T[]): T[] {
  return [...new Set(arr)]
}

function clamp01(v: number): number {
  if (Number.isNaN(v) || !Number.isFinite(v)) return 0
  if (v < 0) return 0
  if (v > 1) return 1
  return v
}