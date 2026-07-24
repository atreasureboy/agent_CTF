import type { CTFTaskState } from '../ctfRuntime/taskState.js'
import type { ModelExecutionIdentity } from '../modelReliability/modelExecutionIdentity.js'
import type { ModelCapabilityProfile } from '../modelReliability/modelCapability.js'
import type { TaskStateProjectionInput } from './contextProjection.js'
import type { CompilerType } from './compiledContext.js'
import type { FindingStore } from '../findings.js'
import type { ArtifactStore } from '../artifacts.js'
import { ToolVisibilityPolicy } from '../toolVisibility/toolVisibilityPolicy.js'
import { computeCanonicalSnapshotHash } from './canonicalSnapshot.js'

export interface TaskStateProjectionBuilderInput {
  state: Readonly<CTFTaskState>
  findingStore?: FindingStore
  artifactStore?: ArtifactStore
  identity: ModelExecutionIdentity
  targetModel?: ModelCapabilityProfile
  compilerType: CompilerType
  toolVisibilityPolicy?: ToolVisibilityPolicy
  getRevisionFn?: (taskId: string) => number
}

export class TaskStateProjectionBuilder {
  public static build(input: TaskStateProjectionBuilderInput): TaskStateProjectionInput {
    const { state, identity, targetModel, toolVisibilityPolicy, getRevisionFn } = input

    const stateRevision = getRevisionFn
      ? getRevisionFn(state.taskId)
      : ((state as any).revision ?? 1)

    const policy = toolVisibilityPolicy || new ToolVisibilityPolicy()
    const allowedTools = policy
      .filterVisibleTools([], {
        role: identity.modelRole,
        modelId: identity.modelId,
        solverId: identity.solverId,
        specialistId: identity.specialistId,
        isOrchestrator: identity.isOrchestrator,
        isWorkflow: identity.isWorkflow,
        isOneShot: identity.isOneShot,
        maxVisibleTools: targetModel?.limits?.maxVisibleTools ?? 20,
      })
      .map((t: any) => (typeof t === 'string' ? t : t.name))

    const stateSnapshotHash = computeCanonicalSnapshotHash({
      taskId: state.taskId,
      stateRevision,
      evidence: state.evidence.map((e) => ({
        id: e.id,
        confidence: e.confidence,
        polarity: e.polarity,
        sourceIds:
          (e as any).sourceIds ||
          (e.sources || []).map((s: any) => s.producer?.runId || s.id || 'src'),
      })),
      hypotheses: state.hypotheses.map((h) => ({
        id: h.id,
        status: h.status,
        confidence: h.confidence,
      })),
      attempts: state.attempts.map((a) => ({
        id: a.id,
        status: a.status,
        fingerprint: a.fingerprint,
      })),
      artifacts: state.artifactIds.map((id) => ({
        id,
      })),
      pendingActions: (state.pendingActions || []).map((p: any) => ({
        id: p.id,
        status: p.status || 'pending',
      })),
      toolExposureHash: allowedTools.sort().join(','),
      compilerVersion: '3.2.0',
    })

    const objective =
      state.challenge.description ||
      `Solve CTF challenge ${state.taskId} (${state.challenge.category || 'general'})`
    const scopeSummary = state.context.contestScope?.allowedFilesRoot || 'workspace_and_targets'

    const evidences = state.evidence.map((e) => ({
      id: e.id,
      title: e.claim,
      factSummary: e.claim,
      confidence: e.confidence,
      confirmed: e.confidence >= 0.8,
    }))

    const hypotheses = state.hypotheses.map((h) => ({
      id: h.id,
      title: h.statement,
      status: h.status,
      reasoning: `Priority ${h.priority}, confidence ${(h.confidence * 100).toFixed(0)}%`,
    }))

    const attempts = state.attempts.map((a) => ({
      id: a.id,
      actionSummary: `${a.kind}:${a.targetId}`,
      fingerprint: a.fingerprint,
      outcome: a.status,
      reason: a.error?.message,
    }))

    const artifacts = state.artifactIds.map((id) => ({
      id,
      path: id,
      description: `Artifact ${id} for task ${state.taskId}`,
    }))

    const pendingActions = state.pendingActions
      ?.filter((p) => p.status === 'pending')
      .map((p: any) => ({
        id: p.id,
        actionName: p.actionName || p.action?.type || p.kind || 'action',
        target: p.target || p.targetId || p.action?.toolId || 'target',
        rationale: p.rationale || p.reason || 'Suggested action',
      }))

    return {
      taskId: state.taskId,
      stateRevision,
      stateSnapshotHash,
      objective,
      scopeSummary,
      evidences,
      hypotheses,
      attempts,
      artifacts,
      actions: pendingActions,
      currentBlocker: state.degraded ? 'Task marked degraded due to diagnostic error' : undefined,
      allowedToolIds: allowedTools,
    }
  }
}
