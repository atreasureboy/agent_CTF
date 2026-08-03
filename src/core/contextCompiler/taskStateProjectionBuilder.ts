import type { CTFTaskState } from '../ctfRuntime/taskState.js'
import type { ModelExecutionIdentity } from '../modelReliability/modelExecutionIdentity.js'
import type { ModelCapabilityProfile } from '../modelReliability/modelCapability.js'
import type { TaskStateProjectionInput } from './contextProjection.js'
import type { CompilerType } from './compiledContext.js'
import type { FindingStore } from '../findings.js'
import type { ArtifactStore } from '../artifacts.js'
import type { ToolRegistry } from '../toolRegistry.js'
import type { ToolExposureResolver } from '../toolVisibility/toolExposureResolver.js'
import { computeCanonicalSnapshotHash } from './canonicalSnapshot.js'
import { ProductionTruthfulnessGuard } from '../runtimeGuard/productionTruthfulnessGuard.js'

export interface TaskStateProjectionBuilderInput {
  state: Readonly<CTFTaskState>
  identity: ModelExecutionIdentity
  targetModel: ModelCapabilityProfile
  compilerType: CompilerType
  toolRegistry: ToolRegistry
  artifactStore: ArtifactStore
  findingStore: FindingStore
  toolExposureResolver: ToolExposureResolver
  getRevisionFn?: (taskId: string) => number
  guard?: ProductionTruthfulnessGuard
}

export class TaskStateProjectionBuilder {
  public static build(input: TaskStateProjectionBuilderInput): TaskStateProjectionInput {
    const {
      state,
      identity,
      targetModel,
      toolRegistry,
      artifactStore,
      findingStore,
      toolExposureResolver,
      getRevisionFn,
      guard = new ProductionTruthfulnessGuard({ mode: 'production' }),
    } = input

    if (!toolRegistry || !artifactStore || !findingStore || !toolExposureResolver) {
      throw new Error(
        '[TaskStateProjectionBuilder] Missing mandatory dependencies (toolRegistry, artifactStore, findingStore, toolExposureResolver).',
      )
    }

    const stateRevision = getRevisionFn
      ? getRevisionFn(state.taskId)
      : ((state as any).revision ?? (state as any).stateRevision)
    if (stateRevision === undefined || stateRevision === null) {
      throw new Error(
        `[TaskStateProjectionBuilder] State revision for task '${state.taskId}' is undefined. Hardcoded fallback is prohibited.`,
      )
    }

    // Build real tool descriptors from ToolRegistry with authentic metadata
    const allToolsDescriptors = toolRegistry.list().map((t) => ({
      name: t.id,
      description: t.impl?.definition?.function?.description || '',
      parameters: (t.impl?.definition?.function?.parameters as Record<string, any>) || {},
      cost: t.costClass === 'expensive' ? 3 : t.costClass === 'medium' ? 2 : 1,
      metadata: {
        visibilityClass:
          t.visibilityClass ??
          (t.domains.some((d) => d === 'meta' || d === 'workflow' || d === 'agent')
            ? 'orchestrator'
            : 'solver'),
        roleMatch: t.roleMatch || [],
        hypothesisMatch: t.hypothesisMatch || [],
        informationGain: t.informationGain ?? 1,
        domains: t.domains,
        executionMode: t.executionMode,
        costClass: t.costClass,
        outputMode: t.outputMode,
        riskLevel: t.riskLevel,
      },
    }))

    const resolvedToolDescriptors = toolExposureResolver.resolveDefinitions({
      identity,
      modelProfile: targetModel,
      taskState: state,
      allTools: allToolsDescriptors,
    })

    const allowedToolIds = resolvedToolDescriptors.map((d) => d.name)

    // Build real artifact refs from ArtifactStore
    const compiledArtifacts = state.artifactIds.map((id) => {
      const meta = artifactStore.getMetadata(id)
      if (!meta) {
        throw new Error(
          `[TaskStateProjectionBuilder] Artifact metadata for '${id}' not found in ArtifactStore.`,
        )
      }

      const authorizedPath = (meta as any).authorizedPath || meta.path
      if (!authorizedPath) {
        throw new Error(
          `[TaskStateProjectionBuilder] Artifact '${id}' has no authorized file path.`,
        )
      }

      guard.assertValidArtifactPath(authorizedPath, id)

      return {
        id,
        authorizedPath,
        sha256: meta.sha256,
        size: meta.size,
        mimeType: meta.mimeType,
        lineage: (meta as any).lineage || (meta.parentArtifactId ? [meta.parentArtifactId] : []),
        createdByAttemptId: meta.attemptId,
        summary: meta.summary,
      }
    })

    // Build real findings from FindingStore
    const taskFindings = findingStore
      .list((f) => f.taskId === state.taskId)
      .map((f) => ({
        id: f.id,
        category: f.category,
        title: f.title,
        confidence: f.confidence,
        summary: f.summary,
      }))

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
      artifacts: compiledArtifacts.map((a) => ({
        id: a.id,
        sha256: a.sha256,
        size: a.size,
        mimeType: a.mimeType,
      })),
      findings: taskFindings.map((f) => ({
        id: f.id,
        severity: f.confidence,
      })),
      pendingActions: (state.pendingActions || []).map((p: any) => ({
        id: p.id,
        status: p.status || 'pending',
      })),
      toolExposureHash: allowedToolIds.slice().sort().join(','),
      compilerVersion: '3.3.0',
    })

    const objective =
      state.challenge.description ||
      `Solve CTF challenge ${state.taskId} (${state.challenge.category || 'general'})`
    const scopeSummary = state.context.contestScope?.allowedFilesRoot || 'workspace_and_targets'

    const evidences = state.evidence.map((e) => {
      const isConfirmed =
        e.polarity === 'supports' &&
        e.confidence >= 0.8 &&
        ((e as any).sourceIds?.length > 0 || (e.sources || []).length > 0)
      return {
        id: e.id,
        title: e.claim,
        factSummary: e.claim,
        confidence: e.confidence,
        confirmed: isConfirmed,
      }
    })

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

    const artifacts = compiledArtifacts.map((a) => ({
      id: a.id,
      path: a.authorizedPath,
      sha256: a.sha256,
      size: a.size,
      mimeType: a.mimeType,
      description: a.summary || `Artifact ${a.id} for task ${state.taskId}`,
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
      allowedToolIds,
    }
  }
}
