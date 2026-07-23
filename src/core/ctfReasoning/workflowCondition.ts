/**
 * WorkflowCondition — Phase 2.1 §十八.
 *
 * Typed condition tree. Replaces the old `when: '<string>'` shape.
 * No JS expression evaluation, no eval — pure structured predicates.
 */

import type { CTFAttempt, CTFHypothesis, FlagCandidate } from '../ctfRuntime/taskState.js'
import type { EvidenceKind, EvidencePolarity } from './evidence.js'
import type { ObservationKind } from './observation.js'

export type WorkflowCondition =
  | { type: 'step_succeeded'; stepId: string }
  | { type: 'step_failed'; stepId: string }
  | {
      type: 'observation_exists'
      kind: ObservationKind
      where?: Record<string, unknown>
      minConfidence?: number
    }
  | {
      type: 'evidence_exists'
      kind: EvidenceKind
      polarity?: EvidencePolarity
      minConfidence?: number
    }
  | {
      type: 'hypothesis_status'
      hypothesisId?: string
      category?: string
      status: CTFHypothesis['status']
    }
  | {
      type: 'flag_candidate_exists'
      minConfidence?: number
      validated?: boolean
    }
  | { type: 'artifact_exists'; artifactType?: string }
  | {
      type: 'attempt_exists'
      fingerprint?: string
      targetId?: string
      statuses?: ReadonlyArray<CTFAttempt['status']>
    }
  | { type: 'all'; conditions: WorkflowCondition[] }
  | { type: 'any'; conditions: WorkflowCondition[] }
  | { type: 'not'; condition: WorkflowCondition }

export interface WorkflowConditionContext {
  state: Readonly<{
    attempts: ReadonlyArray<CTFAttempt>
    hypotheses: ReadonlyArray<CTFHypothesis>
    observations: ReadonlyArray<{ id: string; kind: ObservationKind; confidence: number; attributes: Record<string, unknown> }>
    evidence: ReadonlyArray<{ id: string; kind: EvidenceKind; polarity: EvidencePolarity; confidence: number }>
    flagCandidates: ReadonlyArray<FlagCandidate>
    artifactIds: ReadonlyArray<string>
  }>
  stepOutcomes: ReadonlyMap<string, { status: 'succeeded' | 'failed' | 'cancelled' | 'skipped' }>
}

function attrMatches(
  attrs: Record<string, unknown> | undefined,
  where: Record<string, unknown> | undefined,
): boolean {
  if (!where) return true
  // §round-3 audit fix — treat null/undefined attrs as `{}` so the
  // gate is conservative (false) instead of crashing.
  const a = attrs ?? {}
  for (const [k, v] of Object.entries(where)) {
    if (a[k] !== v) return false
  }
  return true
}

export function evaluateWorkflowCondition(
  condition: WorkflowCondition,
  ctx: WorkflowConditionContext,
): boolean {
  switch (condition.type) {
    case 'step_succeeded':
      return ctx.stepOutcomes.get(condition.stepId)?.status === 'succeeded'
    case 'step_failed':
      return ctx.stepOutcomes.get(condition.stepId)?.status === 'failed'
    case 'observation_exists':
      return ctx.state.observations.some((o) =>
        o.kind === condition.kind &&
        o.confidence >= (condition.minConfidence ?? 0) &&
        attrMatches(o.attributes, condition.where),
      )
    case 'evidence_exists':
      return ctx.state.evidence.some((e) =>
        e.kind === condition.kind &&
        e.confidence >= (condition.minConfidence ?? 0) &&
        (condition.polarity === undefined || e.polarity === condition.polarity),
      )
    case 'hypothesis_status':
      return ctx.state.hypotheses.some((h) =>
        h.status === condition.status &&
        (condition.hypothesisId === undefined || h.id === condition.hypothesisId) &&
        (condition.category === undefined || h.category === condition.category),
      )
    case 'flag_candidate_exists':
      return ctx.state.flagCandidates.some((c) => {
        if (c.confidence < (condition.minConfidence ?? 0)) return false
        if (condition.validated === undefined) return true
        const isValid = c.validation.locallyVerified
        return condition.validated ? isValid : !isValid
      })
    case 'artifact_exists':
      return condition.artifactType === undefined
        ? ctx.state.artifactIds.length > 0
        : ctx.state.artifactIds.length > 0
    case 'attempt_exists':
      return ctx.state.attempts.some((a) => {
        if (condition.fingerprint !== undefined && a.fingerprint !== condition.fingerprint) return false
        if (condition.targetId !== undefined && a.targetId !== condition.targetId) return false
        if (condition.statuses !== undefined && !condition.statuses.includes(a.status)) return false
        return true
      })
    case 'all':
      return condition.conditions.every((c) => evaluateWorkflowCondition(c, ctx))
    case 'any':
      return condition.conditions.some((c) => evaluateWorkflowCondition(c, ctx))
    case 'not':
      return !evaluateWorkflowCondition(condition.condition, ctx)
  }
}