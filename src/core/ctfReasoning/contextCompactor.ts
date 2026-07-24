/**
 * ContextCompactor — Phase borrow-plan Phase G.
 *
 * Inspired by swe-agent v0.7's `LMSummarizer` and CHYing-agent's
 * `ProgressCompiler`: when an observation / evidence array grows past
 * a threshold, replace the older entries with a single summary
 * observation (a "compaction token") that points at the originals.
 *
 * The compactor is pure — it returns a new `CTFTaskState` with the
 * older items removed and the summary appended. The caller (the
 * Reasoning Coordinator) is responsible for emitting a
 * `COMPACTION_APPLIED` event so audit has a record.
 *
 * The compactor is fully deterministic — it picks the first N
 * observations / evidence deterministically. The actual LLM-driven
 * summarisation step (Phase G.2) is a separate adapter that the
 * Coordinator calls when this compactor decides to compact.
 */

import { randomBytes } from 'crypto'
import type { CTFTaskState } from '../ctfRuntime/taskState.js'

export interface CompactionPolicy {
  maxObservations: number
  maxEvidence: number
  maxFindings: number
  maxArtifacts: number
}

export const DEFAULT_COMPACTION_POLICY: CompactionPolicy = {
  maxObservations: 64,
  maxEvidence: 32,
  maxFindings: 32,
  maxArtifacts: 32,
}

export interface CompactionDecision {
  shouldCompact: boolean
  removedObservationIds: string[]
  removedEvidenceIds: string[]
  removedFindingIds: string[]
  removedArtifactIds: string[]
  keptObservations: number
  keptEvidence: number
  keptFindings: number
  keptArtifacts: number
  summaryObservation: string
}

export function decideCompaction(
  state: Readonly<CTFTaskState>,
  policy: CompactionPolicy = DEFAULT_COMPACTION_POLICY,
): CompactionDecision {
  const overObs = state.observations.length > policy.maxObservations
  const overEv = state.evidence.length > policy.maxEvidence
  const overFindings = state.findings.length > policy.maxFindings
  const overArtifacts = state.artifactIds.length > policy.maxArtifacts
  const shouldCompact = overObs || overEv || overFindings || overArtifacts
  if (!shouldCompact) {
    return {
      shouldCompact: false,
      removedObservationIds: [],
      removedEvidenceIds: [],
      removedFindingIds: [],
      removedArtifactIds: [],
      keptObservations: state.observations.length,
      keptEvidence: state.evidence.length,
      keptFindings: state.findings.length,
      keptArtifacts: state.artifactIds.length,
      summaryObservation: '',
    }
  }
  const drop = <T>(arr: T[]): T[] => arr.slice(0, Math.max(0, arr.length - policy.maxObservations))
  const removedObservations = state.observations.slice(
    0,
    Math.max(0, state.observations.length - policy.maxObservations),
  )
  const removedObservationsIds = removedObservations.map((o) => o.id)
  const removedEvidence = state.evidence.slice(
    0,
    Math.max(0, state.evidence.length - policy.maxEvidence),
  )
  const removedEvidenceIds = removedEvidence.map((e) => e.id)
  const removedFindingIds = state.findings
    .slice(0, Math.max(0, state.findings.length - policy.maxFindings))
    .map((f) => f.id)
  const removedArtifactIds = state.artifactIds.slice(
    0,
    Math.max(0, state.artifactIds.length - policy.maxArtifacts),
  )
  const summaryObservation = buildSummary(state, {
    removedObservations,
    removedEvidence,
    removedFindingIds,
    removedArtifactIds,
  })
  return {
    shouldCompact: true,
    removedObservationIds: removedObservationsIds,
    removedEvidenceIds,
    removedFindingIds,
    removedArtifactIds,
    keptObservations: state.observations.length - removedObservationsIds.length,
    keptEvidence: state.evidence.length - removedEvidenceIds.length,
    keptFindings: state.findings.length - removedFindingIds.length,
    keptArtifacts: state.artifactIds.length - removedArtifactIds.length,
    summaryObservation,
  }
  void drop
}

function buildSummary(
  state: Readonly<CTFTaskState>,
  removed: {
    removedObservations: ReadonlyArray<{ id: string; summary: string; kind: string }>
    removedEvidence: ReadonlyArray<{ id: string; kind: string; claim: string }>
    removedFindingIds: ReadonlyArray<string>
    removedArtifactIds: ReadonlyArray<string>
  },
): string {
  const parts: string[] = []
  parts.push(`compaction token ${randomBytes(4).toString('hex')} for task ${state.taskId}`)
  if (removed.removedObservations.length > 0) {
    parts.push(
      `compacted ${removed.removedObservations.length} observation(s): ${removed.removedObservations
        .slice(0, 5)
        .map((o) => `${o.kind}:${o.summary.slice(0, 40)}`)
        .join('; ')}`,
    )
  }
  if (removed.removedEvidence.length > 0) {
    parts.push(
      `compacted ${removed.removedEvidence.length} evidence(s): ${removed.removedEvidence
        .slice(0, 5)
        .map((e) => `${e.kind}:${e.claim.slice(0, 40)}`)
        .join('; ')}`,
    )
  }
  if (removed.removedFindingIds.length > 0) {
    parts.push(`compacted ${removed.removedFindingIds.length} finding(s)`)
  }
  if (removed.removedArtifactIds.length > 0) {
    parts.push(`compacted ${removed.removedArtifactIds.length} artifact(s)`)
  }
  return parts.join(' | ')
}

/** Apply a compaction decision to a state, producing a new state with
 *  the older items removed and a summary observation appended. */
export function applyCompaction(
  state: Readonly<CTFTaskState>,
  decision: CompactionDecision,
  at: number = Date.now(),
): CTFTaskState {
  if (!decision.shouldCompact) return state
  const dropSet = new Set([...decision.removedObservationIds, ...decision.removedEvidenceIds])
  return {
    ...state,
    observations: [
      ...state.observations.filter((o) => !decision.removedObservationIds.includes(o.id)),
      {
        id: `obs_compact_${at.toString(36)}`,
        taskId: state.taskId,
        kind: 'generic' as const,
        source: { type: 'manual' as const },
        summary: decision.summaryObservation,
        attributes: {
          kind: 'compaction_token',
          removedObservationCount: decision.removedObservationIds.length,
          removedEvidenceCount: decision.removedEvidenceIds.length,
          removedFindingCount: decision.removedFindingIds.length,
          removedArtifactCount: decision.removedArtifactIds.length,
        },
        confidence: 1.0,
        createdAt: at,
      },
    ],
    evidence: state.evidence.filter((e) => !decision.removedEvidenceIds.includes(e.id)),
    findings: state.findings.filter((f) => !decision.removedFindingIds.includes(f.id)),
    artifactIds: state.artifactIds.filter((a) => !decision.removedArtifactIds.includes(a)),
    updatedAt: at,
  }
  void dropSet
}
