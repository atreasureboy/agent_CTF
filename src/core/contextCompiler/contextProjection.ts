import { CompiledContext, CompilerType } from './compiledContext.js'
import { ModelRole } from '../modelReliability/modelCapability.js'

export interface TaskStateProjectionInput {
  taskId: string
  stateRevision: number
  stateSnapshotHash: string
  objective: string
  scopeSummary: string

  evidences: Array<{ id: string; title: string; factSummary: string; confidence: number; confirmed: boolean }>
  hypotheses: Array<{ id: string; title: string; status: 'active' | 'confirmed' | 'rejected' | 'pending'; reasoning?: string }>
  attempts: Array<{ id: string; actionSummary: string; fingerprint: string; outcome: string; reason?: string }>
  artifacts: Array<{ id: string; path: string; sha256?: string; description: string }>
  actions?: Array<{ id: string; actionName: string; target: string; rationale: string }>

  currentBlocker?: string
  allowedToolIds: string[]
}

export class ContextProjection {
  public static project(
    input: TaskStateProjectionInput,
    compilerType: CompilerType,
    targetModelId: string,
    targetRole: ModelRole,
  ): CompiledContext {
    const confirmedEv = input.evidences
      .filter((e) => e.confirmed || e.confidence >= 0.8)
      .map((e) => ({
        id: e.id,
        title: e.title,
        factSummary: e.factSummary,
        confidence: e.confidence,
      }))

    const activeHyp = input.hypotheses
      .filter((h) => h.status === 'active')
      .map((h) => ({ id: h.id, title: h.title, status: h.status, reasoning: h.reasoning }))

    const rejectedHyp = input.hypotheses
      .filter((h) => h.status === 'rejected')
      .map((h) => ({ id: h.id, title: h.title, status: h.status, reasoning: h.reasoning }))

    const failedAtt = input.attempts
      .filter((a) => a.outcome === 'failed' || a.outcome === 'error')
      .map((a) => ({
        id: a.id,
        actionSummary: a.actionSummary,
        fingerprint: a.fingerprint,
        outcome: a.outcome,
        reason: a.reason,
      }))

    const forbiddenRepeats = failedAtt.map((a) => a.fingerprint)

    const sourceIds = [
      ...confirmedEv.map((e) => e.id),
      ...activeHyp.map((h) => h.id),
      ...rejectedHyp.map((h) => h.id),
      ...failedAtt.map((a) => a.id),
      ...input.artifacts.map((art) => art.id),
    ]

    const estimatedTokens = Math.ceil(
      (input.objective.length +
        input.scopeSummary.length +
        sourceIds.join('').length +
        forbiddenRepeats.join('').length) /
        4 +
        150,
    )

    return {
      id: `ctx_${compilerType}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      taskId: input.taskId,
      compilerType,
      compilerVersion: '3.0.0',
      stateRevision: input.stateRevision,
      stateSnapshotHash: input.stateSnapshotHash,
      targetModelId,
      targetRole,
      objective: input.objective,
      scopeSummary: input.scopeSummary,
      confirmedEvidence: confirmedEv,
      activeHypotheses: activeHyp,
      rejectedHypotheses: rejectedHyp,
      failedAttempts: failedAtt,
      importantArtifacts: input.artifacts,
      currentBlocker: input.currentBlocker,
      recommendedActions: input.actions || [],
      forbiddenRepeats,
      allowedToolIds: input.allowedToolIds,
      completionContract: ['output_valid_schema', 'respect_scope', 'do_not_hallucinate_evidence'],
      sourceIds,
      estimatedTokens,
      createdAt: Date.now(),
    }
  }
}
