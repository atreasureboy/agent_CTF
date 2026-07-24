/**
 * RuntimeStrategyActionExecutor — Phase 2.3 §四.
 *
 * Production StrategyActionExecutor interface adapter. The runtime
 * that builds a `CTFTaskRuntime` injects a concrete adapter that
 * knows how to call:
 *
 *   - Orchestrator.runWorkflow (run_workflow)
 *   - Dispatcher.runOne (run_oneshot)
 *   - ToolBroker.execute (call_tool)
 *   - Orchestrator.requestHandoff + approveHandoff (request_handoff)
 *   - FlagCandidateValidator (verify_flag)
 *   - stop → never reaches Executor (Coordinator handles before Attempt)
 *
 * Coordinator uses the `execute` interface; concrete adapter is
 * constructed at runtime assembly.
 *
 * For tests we provide a `NoopStrategyActionExecutor` (only allowed in
 * explicit dry-run mode) and a `FakeStrategyActionExecutor` that
 * records calls.
 */

import type { CTFTaskState } from '../ctfRuntime/taskState.js'
import type {
  ActionExecutionResult,
  ExecutionRefs,
} from './actionExecutionResult.js'
import type { MaterializedResult } from './parserRegistry.js'
import type {
  StrategyActionExecutor,
  StrategyActionExecutorContext,
} from './strategyActionExecutor.js'
import { materialize } from './resultMaterializer.js'
import type { SuggestedAction } from './suggestedAction.js'
import type { ReasoningExecutionContext } from './reasoningCascade.js'

/* ─── Minimal façade types — the production adapter wires concrete
 *     Runtime types at construction time. We avoid importing them
 *     here so the file stays decoupled and test-mockable. */

export interface RuntimeSurface {
  runWorkflow(input: {
    workflowId: string
    inputs: Record<string, unknown>
    initiatedByAgentRunId?: string
  }): Promise<{
    workflowId: string
    status: 'completed' | 'partial' | 'failed' | 'cancelled'
    emittedArtifactIds: string[]
    warnings: string[]
  }>
  runOneShot(input: {
    manifestId: string
    inputArtifactIds: string[]
    options?: Record<string, unknown>
  }): Promise<{
    runId: string
    summary?: string
    artifactIds: string[]
  }>
  callTool(input: {
    toolId: string
    taskId: string
    profileId: string
    cwd: string
    signal: AbortSignal
    input: Record<string, unknown>
  }): Promise<{
    content: string
    isError: boolean
    exitCode?: number
    artifactId?: string
  }>
  requestHandoff(input: {
    objective: string
    targetCapability: string
    reason: string
    artifactIds: string[]
    evidenceIds: string[]
    hypothesisIds: string[]
  }): Promise<{ handoffId: string; agentRunId?: string }>
  verifyFlag(input: { candidateId: string; value: string }): Promise<{
    validated: boolean
    errors: string[]
  }>
  resolveProfileId(taskId: string): string
  resolveCwd(taskId: string): string
}

export function createRuntimeStrategyActionExecutor(
  surface: RuntimeSurface,
): StrategyActionExecutor {
  return {
    async execute(ctx: StrategyActionExecutorContext): Promise<ActionExecutionResult> {
      const { action } = ctx
      const reasoningContext: ReasoningExecutionContext = {
        taskId: ctx.taskState.taskId,
        strategyDecisionId: '',
        attemptId: ctx.attempt.id,
        cascadeId: '',
        reasoningDepth: 0,
      }
      switch (action.type) {
        case 'run_workflow':
          return executeRunWorkflow(action, surface, ctx, reasoningContext)
        case 'run_oneshot':
          return executeRunOneshot(action, surface, ctx, reasoningContext)
        case 'call_tool':
          return executeCallTool(action, surface, ctx, reasoningContext)
        case 'request_handoff':
          return executeRequestHandoff(action, surface, ctx, reasoningContext)
        case 'verify_flag':
          return executeVerifyFlag(action, surface, ctx, reasoningContext)
        case 'stop':
          throw new Error(
            'RuntimeStrategyActionExecutor: stop Action reached Executor. ' +
              'Coordinator must handle stop before Attempt creation.',
          )
      }
    },
  }
}

async function executeRunWorkflow(
  action: Extract<SuggestedAction, { type: 'run_workflow' }>,
  s: RuntimeSurface,
  ctx: StrategyActionExecutorContext,
  _rc: ReasoningExecutionContext,
): Promise<ActionExecutionResult> {
  const r = await s.runWorkflow({
    workflowId: action.workflowId,
    inputs: action.inputs,
  })
  return {
    status: 'executed',
    materializedResult: {
      observations: [],
      evidence: [],
      suggestedActions: [],
      flagCandidateDrafts: [],
      warnings: r.warnings,
      rawArtifactIds: r.emittedArtifactIds,
    },
    executionRefs: { workflowRunId: r.workflowId, attemptId: ctx.attempt.id },
    resultAlreadyProjected: true,
  }
}

async function executeRunOneshot(
  action: Extract<SuggestedAction, { type: 'run_oneshot' }>,
  s: RuntimeSurface,
  ctx: StrategyActionExecutorContext,
  _rc: ReasoningExecutionContext,
): Promise<ActionExecutionResult> {
  const r = await s.runOneShot({
    manifestId: action.manifestId,
    inputArtifactIds: action.inputArtifactIds,
    options: action.options,
  })
  return {
    status: 'executed',
    materializedResult: {
      observations: [],
      evidence: [],
      suggestedActions: [],
      flagCandidateDrafts: [],
      warnings: [],
      rawArtifactIds: r.artifactIds,
    },
    executionRefs: { oneShotRunId: r.runId, attemptId: ctx.attempt.id },
    resultAlreadyProjected: true,
  }
}

async function executeCallTool(
  action: Extract<SuggestedAction, { type: 'call_tool' }>,
  s: RuntimeSurface,
  ctx: StrategyActionExecutorContext,
  _rc: ReasoningExecutionContext,
): Promise<ActionExecutionResult> {
  const r = await s.callTool({
    toolId: action.toolId,
    taskId: ctx.taskState.taskId,
    profileId: s.resolveProfileId(ctx.taskState.taskId),
    cwd: s.resolveCwd(ctx.taskState.taskId),
    signal: ctx.signal,
    input: action.input,
  })
  // §C3 — invoke materialize() so raw tool output becomes
  // Observation / Evidence / FlagCandidate drafts. Without this the
  // planner's feedback loop is empty for tools.
  const mat = await materialize(ctx.taskState.taskId, {
    type: 'tool',
    toolId: action.toolId,
    content: r.content,
    artifactIds: r.artifactId ? [r.artifactId] : [],
    exitCode: r.exitCode,
    isError: r.isError,
  })
  return {
    status: 'executed',
    materializedResult: mat,
    executionRefs: { attemptId: ctx.attempt.id },
  }
}

async function executeRequestHandoff(
  action: Extract<SuggestedAction, { type: 'request_handoff' }>,
  s: RuntimeSurface,
  ctx: StrategyActionExecutorContext,
  _rc: ReasoningExecutionContext,
): Promise<ActionExecutionResult> {
  const r = await s.requestHandoff({
    objective: action.objective,
    targetCapability: action.capability,
    reason: action.reason,
    artifactIds: action.artifactIds,
    evidenceIds: action.evidenceIds ?? [],
    hypothesisIds: action.hypothesisIds ?? [],
  })
  return {
    status: 'executed',
    materializedResult: {
      observations: [],
      evidence: [],
      suggestedActions: [],
      flagCandidateDrafts: [],
      warnings: [],
      rawArtifactIds: [],
    },
    executionRefs: {
      handoffId: r.handoffId,
      agentRunId: r.agentRunId,
      attemptId: ctx.attempt.id,
    },
    resultAlreadyProjected: true,
  }
}

async function executeVerifyFlag(
  action: Extract<SuggestedAction, { type: 'verify_flag' }>,
  s: RuntimeSurface,
  ctx: StrategyActionExecutorContext,
  _rc: ReasoningExecutionContext,
): Promise<ActionExecutionResult> {
  const cand = ctx.taskState.flagCandidates.find((c) => c.id === action.candidateId)
  const decision = await s.verifyFlag({
    candidateId: action.candidateId,
    value: cand?.value ?? '',
  })
  return {
    status: 'executed',
    materializedResult: {
      observations: [
        {
          kind: 'generic',
          source: { type: 'workflow', workflowId: 'flag-validator' },
          summary: decision.validated
            ? `flag candidate ${action.candidateId} validated`
            : `flag candidate ${action.candidateId} rejected`,
          attributes: { errors: decision.errors, patternMatched: decision.validated },
          confidence: decision.validated ? 0.95 : 0.85,
        },
      ],
      evidence: [],
      suggestedActions: decision.validated
        ? [{ type: 'stop', reason: 'validated flag candidate found', priority: 1, costTier: 'cheap' }]
        : [],
      flagCandidateDrafts: [],
      warnings: decision.errors,
      rawArtifactIds: [],
    },
    executionRefs: { attemptId: ctx.attempt.id },
  }
}

/* ─── Production-only Noop (for dry-run mode). ──────────────── */

export class MissingStrategyActionExecutorError extends Error {
  constructor() {
    super(
      'RuntimeStrategyActionExecutor: production Runtime requires a ' +
        'concrete StrategyActionExecutor. Use createNoopStrategyActionExecutor ' +
        'only in dry-run mode.',
    )
    this.name = 'MissingStrategyActionExecutorError'
  }
}

export function createNoopStrategyActionExecutor(): StrategyActionExecutor {
  return {
    async execute(_ctx: StrategyActionExecutorContext): Promise<ActionExecutionResult> {
      return {
        status: 'executed',
        materializedResult: emptyMaterializedResult(),
        executionRefs: {},
      }
    },
  }
}

export function emptyMaterializedResult(): MaterializedResult {
  return {
    observations: [],
    evidence: [],
    suggestedActions: [],
    flagCandidateDrafts: [],
    warnings: [],
    rawArtifactIds: [],
  }
}

/** Test seam — records every execute() call. Production code never
 *  receives this. */
export interface FakeExecutorCall {
  action: SuggestedAction
  attemptId: string
  taskId: string
}

export function createFakeStrategyActionExecutor(
  handlers?: Partial<Record<SuggestedAction['type'], (ctx: StrategyActionExecutorContext) => Promise<ActionExecutionResult> | ActionExecutionResult>>,
): StrategyActionExecutor & { calls: FakeExecutorCall[] } {
  const calls: FakeExecutorCall[] = []
  return {
    calls,
    async execute(ctx: StrategyActionExecutorContext): Promise<ActionExecutionResult> {
      calls.push({ action: ctx.action, attemptId: ctx.attempt.id, taskId: ctx.taskState.taskId })
      const h = handlers?.[ctx.action.type]
      if (h) {
        return await Promise.resolve(h(ctx))
      }
      return {
        status: 'executed',
        materializedResult: emptyMaterializedResult(),
        executionRefs: { attemptId: ctx.attempt.id },
      }
    },
  }
}