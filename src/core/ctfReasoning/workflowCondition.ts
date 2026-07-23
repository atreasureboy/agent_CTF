/**
 * WorkflowCondition — Phase 2.2 §十二.
 *
 * Typed condition tree. Replaces the old `when: '<string>'` shape.
 * No JS expression evaluation, no eval — pure structured predicates.
 *
 * Scope (§十二):
 *   Every condition that reads TaskState (evidence_exists,
 *   observation_exists, artifact_exists, flag_candidate_exists,
 *   attempt_exists, hypothesis_status) accepts a `ConditionScope`:
 *
 *     scope?: ConditionScope = { workflowRunId: '$current' }
 *
 *   By default a condition scoped to a Workflow only sees state that
 *   the current workflow run produced. To query across the whole
 *   task, set `scopeMode: 'task'` and an explicit `taskId`.
 *
 *   artifact_exists (§十三) gains real predicates on the artifact
 *   metadata: artifactKind, mimeType, extension, producedByStepId,
 *   producedByWorkflowRunId, producedByOneShotRunId,
 *   parentArtifactId, minCreatedAt.
 */

import type { CTFAttempt, CTFHypothesis, FlagCandidate } from '../ctfRuntime/taskState.js'
import type { EvidenceKind, EvidencePolarity } from './evidence.js'
import type { ObservationKind } from './observation.js'

export type ScopeMode = 'workflow' | 'task'

/**
 * ConditionScope — restricts what state a condition can see.
 *
 *   - Default: { workflowRunId: '$current', scopeMode: 'workflow' }
 *   - Explicit task-wide: { taskId, scopeMode: 'task' }
 *
 * Fields:
 *   - taskId: limit to a specific task
 *   - workflowRunId: limit to a specific workflow run (or '$current')
 *   - stepId: limit to a specific step inside the workflow run
 *   - agentRunId, oneShotRunId, handoffId: limit to a specific runner
 *   - producerId: limit to a specific parser/producer id
 *   - artifactIds: only consider these artifact ids
 *   - sinceTimestamp: only state produced after this epoch ms
 */
export interface ConditionScope {
  scopeMode?: ScopeMode
  taskId?: string
  workflowRunId?: string
  stepId?: string
  agentRunId?: string
  oneShotRunId?: string
  handoffId?: string
  producerId?: string
  artifactIds?: ReadonlyArray<string>
  /** Number = absolute epoch ms. '$workflowStartedAt' = current
   *  workflow started timestamp (resolved at evaluation time). */
  sinceTimestamp?: number | '$workflowStartedAt'
}

/** Artifact metadata that `artifact_exists` predicates against. */
export interface ArtifactMetadataView {
  id: string
  kind?: string
  mimeType?: string
  extension?: string
  producedByStepId?: string
  producedByWorkflowRunId?: string
  producedByOneShotRunId?: string
  parentArtifactId?: string
  createdAt?: number
}

export type WorkflowCondition =
  | { type: 'step_succeeded'; stepId: string }
  | { type: 'step_failed'; stepId: string }
  | {
      type: 'observation_exists'
      kind: ObservationKind
      scope?: ConditionScope
      where?: Record<string, unknown>
      minConfidence?: number
    }
  | {
      type: 'evidence_exists'
      kind: EvidenceKind
      scope?: ConditionScope
      polarity?: EvidencePolarity
      where?: Record<string, unknown>
      minConfidence?: number
    }
  | {
      type: 'hypothesis_status'
      hypothesisId?: string
      category?: string
      status: CTFHypothesis['status']
      scope?: ConditionScope
    }
  | {
      type: 'flag_candidate_exists'
      scope?: ConditionScope
      minConfidence?: number
      validated?: boolean
    }
  | {
      type: 'artifact_exists'
      artifactKind?: string
      mimeType?: string
      extension?: string
      producedByStepId?: string
      producedByWorkflowRunId?: string
      producedByOneShotRunId?: string
      parentArtifactId?: string
      minCreatedAt?: number | '$workflowStartedAt'
      scope?: ConditionScope
    }
  | {
      type: 'attempt_exists'
      fingerprint?: string
      targetId?: string
      statuses?: ReadonlyArray<CTFAttempt['status']>
      scope?: ConditionScope
    }
  | { type: 'all'; conditions: WorkflowCondition[] }
  | { type: 'any'; conditions: WorkflowCondition[] }
  | { type: 'not'; condition: WorkflowCondition }

export interface ObservationView {
  id: string
  kind: ObservationKind
  confidence: number
  attributes: Record<string, unknown>
  workflowRunId?: string
  stepId?: string
  oneShotRunId?: string
  agentRunId?: string
  handoffId?: string
  createdAt: number
}

export interface EvidenceView {
  id: string
  kind: EvidenceKind
  polarity: EvidencePolarity
  confidence: number
  sources: Array<{
    producer: { type: string; id: string }
    attemptIds: string[]
    artifactIds: string[]
    createdAt: number
  }>
  attributes?: Record<string, unknown>
  createdAt: number
}

export interface FlagCandidateView {
  id: string
  confidence: number
  validation: { locallyVerified: boolean; patternMatched: boolean }
  sourceAttemptIds: string[]
  sourceArtifactIds: string[]
  createdAt: number
}

export interface HypothesisView {
  id: string
  status: CTFHypothesis['status']
  category: string
}

export interface AttemptView {
  id: string
  fingerprint?: string
  targetId?: string
  status: CTFAttempt['status']
  workflowRunId?: string
  stepId?: string
  oneShotRunId?: string
  createdAt: number
}

export interface WorkflowConditionContext {
  state: Readonly<{
    taskId: string
    attempts: ReadonlyArray<AttemptView>
    hypotheses: ReadonlyArray<HypothesisView>
    observations: ReadonlyArray<ObservationView>
    evidence: ReadonlyArray<EvidenceView>
    flagCandidates: ReadonlyArray<FlagCandidateView>
    artifactIds: ReadonlyArray<string>
    artifacts?: ReadonlyMap<string, ArtifactMetadataView>
    /** Token substituted for `$current` in scope fields. */
    currentWorkflowRunId?: string
    currentStepId?: string
    /** When the current workflow started — substitute for `$workflowStartedAt`. */
    currentWorkflowStartedAt?: number
  }>
  stepOutcomes: ReadonlyMap<string, { status: 'succeeded' | 'failed' | 'cancelled' | 'skipped' }>
}

/** Default scope: only items produced by the current WorkflowRun. */
export function defaultWorkflowScope(currentWorkflowRunId?: string): ConditionScope {
  return currentWorkflowRunId !== undefined
    ? { scopeMode: 'workflow', workflowRunId: '$current' }
    : { scopeMode: 'task' }
}

/** Resolve `$current` / `$workflowStartedAt` tokens in a ConditionScope
 *  against the current run. */
export function resolveScope(
  scope: ConditionScope | undefined,
  ctx: WorkflowConditionContext,
  fallbackWorkflowRunId?: string,
): ConditionScope {
  if (!scope) return defaultWorkflowScope(fallbackWorkflowRunId ?? ctx.state.currentWorkflowRunId)
  const currentRunId = scope.workflowRunId === '$current'
    ? (ctx.state.currentWorkflowRunId ?? fallbackWorkflowRunId)
    : scope.workflowRunId
  const startedAt = scope.sinceTimestamp !== undefined && scope.sinceTimestamp === ('$workflowStartedAt' as unknown as number)
    ? ctx.state.currentWorkflowStartedAt
    : scope.sinceTimestamp
  return { ...scope, workflowRunId: currentRunId, sinceTimestamp: startedAt }
}

function attrMatches(
  attrs: Record<string, unknown> | undefined,
  where: Record<string, unknown> | undefined,
): boolean {
  if (!where) return true
  const a = attrs ?? {}
  for (const [k, v] of Object.entries(where)) {
    if (a[k] !== v) return false
  }
  return true
}

function matchesScope(
  ctx: WorkflowConditionContext,
  scope: ConditionScope | undefined,
  workflowRunId?: string,
  stepId?: string,
  oneShotRunId?: string,
  agentRunId?: string,
  handoffId?: string,
  producerId?: string,
  createdAt?: number,
): boolean {
  if (!scope) return true
  if (scope.taskId !== undefined && ctx.state.taskId !== scope.taskId) return false
  if (scope.workflowRunId !== undefined && workflowRunId !== scope.workflowRunId) return false
  if (scope.stepId !== undefined && stepId !== scope.stepId) return false
  if (scope.agentRunId !== undefined && agentRunId !== scope.agentRunId) return false
  if (scope.oneShotRunId !== undefined && oneShotRunId !== scope.oneShotRunId) return false
  if (scope.handoffId !== undefined && handoffId !== scope.handoffId) return false
  if (scope.producerId !== undefined && producerId !== scope.producerId) return false
  if (scope.sinceTimestamp !== undefined && createdAt !== undefined && typeof scope.sinceTimestamp === 'number' && createdAt < scope.sinceTimestamp) {
    return false
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

    case 'observation_exists': {
      const scope = resolveScope(condition.scope, ctx)
      return ctx.state.observations.some((o) =>
        o.kind === condition.kind &&
        o.confidence >= (condition.minConfidence ?? 0) &&
        attrMatches(o.attributes, condition.where) &&
        matchesScope(ctx, scope, o.workflowRunId, o.stepId, o.oneShotRunId, o.agentRunId, o.handoffId, undefined, o.createdAt),
      )
    }

    case 'evidence_exists': {
      const scope = resolveScope(condition.scope, ctx)
      return ctx.state.evidence.some((e) => {
        if (e.kind !== condition.kind) return false
        if (e.confidence < (condition.minConfidence ?? 0)) return false
        if (condition.polarity !== undefined && e.polarity !== condition.polarity) return false
        if (!attrMatches(e.attributes, condition.where)) return false
        const producerMatch = scope.producerId
          ? e.sources.some((s) => `${s.producer.type}:${s.producer.id}` === scope.producerId
              || s.producer.id === scope.producerId)
          : true
        return producerMatch
      })
    }

    case 'hypothesis_status':
      return ctx.state.hypotheses.some((h) =>
        h.status === condition.status &&
        (condition.hypothesisId === undefined || h.id === condition.hypothesisId) &&
        (condition.category === undefined || h.category === condition.category),
      )

    case 'flag_candidate_exists': {
      const scope = resolveScope(condition.scope, ctx)
      return ctx.state.flagCandidates.some((c) => {
        if (c.confidence < (condition.minConfidence ?? 0)) return false
        if (condition.validated !== undefined) {
          const isValid = c.validation.locallyVerified
          if (condition.validated !== isValid) return false
        }
        if (scope.workflowRunId !== undefined && !c.sourceAttemptIds.length) return false
        return true
      })
    }

    case 'artifact_exists': {
      // §十三 — real metadata predicates, not just `length > 0`.
      const scope = resolveScope(condition.scope, ctx)
      const ids = ctx.state.artifactIds
      const meta = ctx.state.artifacts
      for (const id of ids) {
        const m = meta?.get(id)
        const createdAt = m?.createdAt
        const producedByWorkflowRunId = m?.producedByWorkflowRunId
        const producedByStepId = m?.producedByStepId
        const producedByOneShotRunId = m?.producedByOneShotRunId
        const parentArtifactId = m?.parentArtifactId
        if (condition.artifactKind !== undefined && m?.kind !== condition.artifactKind) continue
        if (condition.mimeType !== undefined && m?.mimeType !== condition.mimeType) continue
        if (condition.extension !== undefined && m?.extension !== condition.extension) continue
        if (condition.producedByStepId !== undefined && producedByStepId !== condition.producedByStepId) continue
        if (condition.producedByWorkflowRunId !== undefined
            && producedByWorkflowRunId !== resolveToken(condition.producedByWorkflowRunId, ctx)) continue
        if (condition.producedByOneShotRunId !== undefined
            && producedByOneShotRunId !== condition.producedByOneShotRunId) continue
        if (condition.parentArtifactId !== undefined && parentArtifactId !== condition.parentArtifactId) continue
        if (condition.minCreatedAt !== undefined && (createdAt ?? 0) < resolveMinCreatedAt(condition.minCreatedAt, ctx)) continue
        if (scope.workflowRunId !== undefined
            && producedByWorkflowRunId !== resolveToken(scope.workflowRunId, ctx)) continue
        return true
      }
      return false
    }

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

function resolveToken(token: string, ctx: WorkflowConditionContext): string | undefined {
  if (token === '$current') return ctx.state.currentWorkflowRunId
  return token
}

function resolveMinCreatedAt(token: number | string, ctx: WorkflowConditionContext): number {
  if (typeof token === 'string' && token === '$workflowStartedAt') {
    return ctx.state.currentWorkflowStartedAt ?? 0
  }
  return typeof token === 'number' ? token : 0
}

// Re-export FlagCandidate type used by some callers in tests for ergonomics.
export type { FlagCandidate }