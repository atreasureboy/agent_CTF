/**
 * typedDagExecutor — Phase 2.1 §二十二 / §二十一.
 *
 * Executes a `TypedWorkflowDefinition`:
 *   - validates the DAG (unique ids, dependsOn references, cycle
 *     detection)
 *   - schedules independent steps in parallel
 *   - per-step retry with backoff, capped at maxAttempts
 *   - evaluates stopConditions after each step
 *   - records each execution in an `AttemptExecution` (same Attempt)
 *   - returns a typed result with `stoppedEarly` + `matchedStopCondition`
 *
 * The executor never throws on a single step failure — it records the
 * failure in the Attempt's `error` field and proceeds per the
 * `dependencyFailurePolicy`.
 */

import type {
  TypedWorkflowDefinition,
  TypedWorkflowStep,
} from './workflowDefinition.js'
import type { WorkflowCondition } from './ctfReasoning/workflowCondition.js'
import { evaluateWorkflowCondition } from './ctfReasoning/workflowCondition.js'
import type { AttemptExecution } from './ctfRuntime/taskState.js'

export type DependencyFailurePolicy = 'skip' | 'continue' | 'abort'

export interface RetryConfig {
  maxAttempts: number
  backoffMs?: number
  backoffMultiplier?: number
  retryOn?: ReadonlyArray<'timeout' | 'temporary_error' | 'tool_unavailable' | 'nonzero_exit'>
}

export interface TypedStepOutcome {
  stepId: string
  status: 'succeeded' | 'failed' | 'cancelled' | 'skipped'
  durationMs: number
  error?: string
  /** Per-execution records when retry kicks in. */
  executions: AttemptExecution[]
  /** The final attempt id (the same Attempt covers all retries). */
  attemptId?: string
}

export interface TypedWorkflowRunResult {
  workflowId: string
  status: 'success' | 'partial' | 'failed' | 'cancelled'
  startedAt: string
  endedAt: string
  stepOutcomes: TypedStepOutcome[]
  stoppedEarly: boolean
  matchedStopCondition?: WorkflowCondition
  stopReason?: string
  observationIds: string[]
  evidenceIds: string[]
  strategyDecisionIds: string[]
}

export interface TypedDagRunContext {
  taskId: string
  workflowId: string
  inputs: Record<string, unknown>
  capturedOutputs: Map<string, string>
  signal?: AbortSignal
  dependencyFailurePolicy?: DependencyFailurePolicy
  /** Each step gets a fresh attempt id from the runner. */
  issueAttemptId: () => string
  /** Notify the runner that a step has been retried with N executions. */
  recordExecutions: (attemptId: string, stepId: string, executions: AttemptExecution[]) => void
}

export interface TypedStepRunner {
  runTool(step: Extract<TypedWorkflowStep, { kind: 'tool' }>, ctx: TypedDagRunContext): Promise<{ content: string; isError: boolean; errorCode?: string; artifactIds: string[] }>
  runHandoff(step: Extract<TypedWorkflowStep, { kind: 'request_handoff' }>, ctx: TypedDagRunContext): Promise<{ content: string; isError: boolean; artifactIds: string[] }>
  emitFinding(step: Extract<TypedWorkflowStep, { kind: 'emit_finding' }>, ctx: TypedDagRunContext): Promise<{ observationIds: string[]; evidenceIds: string[] }>
}

export class TypedDagValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TypedDagValidationError'
  }
}

export class TypedDagCycleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TypedDagCycleError'
  }
}

/** Validate the DAG. Throws on duplicates, missing dependsOn refs,
 *  or cycles. */
export function validateTypedDag(workflow: TypedWorkflowDefinition): void {
  const ids = new Set<string>()
  for (const step of workflow.steps) {
    if (ids.has(step.id)) {
      throw new TypedDagValidationError(`duplicate step id: ${step.id}`)
    }
    ids.add(step.id)
  }
  for (const step of workflow.steps) {
    for (const dep of step.dependsOn ?? []) {
      if (!ids.has(dep)) {
        throw new TypedDagValidationError(
          `step ${step.id} depends on unknown step ${dep}`,
        )
      }
    }
  }
  // Cycle detection via Kahn's algorithm.
  const indeg = new Map<string, number>()
  const adj = new Map<string, string[]>()
  for (const step of workflow.steps) {
    indeg.set(step.id, 0)
    adj.set(step.id, [])
  }
  for (const step of workflow.steps) {
    for (const dep of step.dependsOn ?? []) {
      adj.get(dep)!.push(step.id)
      indeg.set(step.id, (indeg.get(step.id) ?? 0) + 1)
    }
  }
  const queue: string[] = []
  for (const [id, d] of indeg) if (d === 0) queue.push(id)
  let visited = 0
  while (queue.length) {
    const id = queue.shift()!
    visited++
    for (const next of adj.get(id) ?? []) {
      const d = (indeg.get(next) ?? 0) - 1
      indeg.set(next, d)
      if (d === 0) queue.push(next)
    }
  }
  if (visited !== workflow.steps.length) {
    throw new TypedDagCycleError(`cycle detected in workflow ${workflow.id}`)
  }
}

const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_BACKOFF_MS = 200
const DEFAULT_BACKOFF_MULTIPLIER = 2

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'))
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(t)
      reject(new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function retryShouldGiveUp(
  retry: RetryConfig,
  attemptIndex: number,
  errorCode: string | undefined,
): boolean {
  if (attemptIndex >= retry.maxAttempts - 1) return true
  if (!retry.retryOn || retry.retryOn.length === 0) return true
  // §round-3 audit fix — an absent errorCode is NOT retryable. The
  // previous code returned `false` (continue retrying) for any
  // unclassified error, which silently retries cancelled runs.
  if (!errorCode) return true
  return !retry.retryOn.includes(errorCode as 'timeout' | 'temporary_error' | 'tool_unavailable' | 'nonzero_exit')
}

async function runStepWithRetry(
  step: Extract<TypedWorkflowStep, { kind: 'tool' }>,
  ctx: TypedDagRunContext,
  runner: TypedStepRunner,
  attemptId: string,
): Promise<{ outcome: TypedStepOutcome; status: 'ok' | 'aborted' }> {
  const retry: RetryConfig = {
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    backoffMs: DEFAULT_BACKOFF_MS,
    backoffMultiplier: DEFAULT_BACKOFF_MULTIPLIER,
    ...(step as { retry?: RetryConfig }).retry,
  }
  const startedAt = Date.now()
  const executions: AttemptExecution[] = []
  let lastResult: Awaited<ReturnType<TypedStepRunner['runTool']>> | null = null
  let lastError: string | undefined
  for (let i = 0; i < retry.maxAttempts; i++) {
    const execStart = Date.now()
    try {
      const r = await runner.runTool(step, ctx)
      const status = r.isError ? 'failed' : 'succeeded'
      executions.push({ index: i, startedAt: execStart, completedAt: Date.now(), status: status === 'succeeded' ? 'succeeded' : 'failed', errorCode: r.errorCode, errorMessage: r.isError ? r.content : undefined })
      if (!r.isError) {
        lastResult = r
        break
      }
      lastResult = r
      lastError = r.content
      if (retryShouldGiveUp(retry, i, r.errorCode ?? 'nonzero_exit')) break
      if (i < retry.maxAttempts - 1) {
        const backoff = (retry.backoffMs ?? DEFAULT_BACKOFF_MS) * Math.pow(retry.backoffMultiplier ?? DEFAULT_BACKOFF_MULTIPLIER, i)
        try {
          await sleep(backoff, ctx.signal)
        } catch (err) {
          executions.push({ index: i, startedAt: execStart, completedAt: Date.now(), status: 'cancelled', errorMessage: (err as Error).message })
          ctx.recordExecutions(attemptId, step.id, executions)
          return {
            outcome: {
              stepId: step.id,
              status: 'cancelled',
              durationMs: Date.now() - startedAt,
              error: (err as Error).message,
              executions,
              attemptId,
            },
            status: 'aborted',
          }
        }
      }
    } catch (err) {
      executions.push({ index: i, startedAt: execStart, completedAt: Date.now(), status: 'failed', errorMessage: (err as Error).message })
      lastError = (err as Error).message
      if (retryShouldGiveUp(retry, i, 'temporary_error')) break
    }
  }
  ctx.recordExecutions(attemptId, step.id, executions)
  const ok = lastResult && !lastResult.isError
  return {
    outcome: {
      stepId: step.id,
      status: ok ? 'succeeded' : 'failed',
      durationMs: Date.now() - startedAt,
      error: ok ? undefined : lastError,
      executions,
      attemptId,
    },
    status: 'ok',
  }
}

export async function runTypedDag(
  workflow: TypedWorkflowDefinition,
  ctx: TypedDagRunContext,
  runner: TypedStepRunner,
): Promise<TypedWorkflowRunResult> {
  validateTypedDag(workflow)
  const startedAt = new Date().toISOString()
  const outcomes: TypedStepOutcome[] = []
  const observationIds: string[] = []
  const evidenceIds: string[] = []
  const strategyDecisionIds: string[] = []
  const policy: DependencyFailurePolicy = ctx.dependencyFailurePolicy ?? 'skip'
  const depFailure = new Set<string>()
  const completed = new Set<string>()

  // Topological order.
  const remaining = new Map<string, number>()
  const adj = new Map<string, string[]>()
  for (const s of workflow.steps) {
    remaining.set(s.id, (s.dependsOn ?? []).length)
    adj.set(s.id, [])
  }
  for (const s of workflow.steps) {
    for (const dep of s.dependsOn ?? []) {
      adj.get(dep)!.push(s.id)
    }
  }

  let stoppedEarly = false
  let matchedStopCondition: WorkflowCondition | undefined
  let stopReason: string | undefined

  // Iterate until all steps are processed or stop condition fires.
  while (outcomes.length + depFailure.size < workflow.steps.length && !stoppedEarly) {
    const ready = workflow.steps.filter(
      (s) => (remaining.get(s.id) ?? 0) === 0 && !completed.has(s.id) && !depFailure.has(s.id),
    )
    if (ready.length === 0) break
    // Run ready steps in parallel.
    const results = await Promise.allSettled(
      ready.map(async (step) => {
        if (ctx.signal?.aborted) throw new Error('aborted')
        if (step.kind === 'if') {
          // §round-3 audit fix — execute the selected branch and
          // record one outcome for the parent + one for each child.
          // Previously the parent recorded as 'succeeded' without
          // running anything, which made stop conditions evaluate
          // stale state and made workflows containing only
          // if/emit_finding/request_handoff end as 'failed'.
          const start = Date.now()
          const cond = evaluateWorkflowCondition(step.condition, {
            state: { taskId: ctx.taskId,
              attempts: [],
              hypotheses: [],
              observations: [],
              evidence: [],
              flagCandidates: [],
              artifactIds: [],
            },
            stepOutcomes: stepOutcomesToMap(outcomes),
          })
          const branch = cond ? step.then : (step.else ?? [])
          const childResults: Array<{ status: 'succeeded' | 'failed' | 'cancelled'; error?: string }> = []
          for (const sub of branch) {
            if (ctx.signal?.aborted) {
              childResults.push({ status: 'cancelled', error: 'aborted' })
              continue
            }
            try {
              if (sub.kind === 'tool') {
                const attemptId = ctx.issueAttemptId()
                const r = await runStepWithRetry(sub, ctx, runner, attemptId)
                // §round-3 audit fix — normalize 'skipped' → 'succeeded'
                // for child-result accounting. The parent's status
                // doesn't need a 'skipped' value.
                const childStatus: 'succeeded' | 'failed' | 'cancelled' =
                  r.outcome.status === 'succeeded'
                    ? 'succeeded'
                    : r.outcome.status === 'cancelled'
                      ? 'cancelled'
                      : 'failed'
                childResults.push({ status: childStatus, error: r.outcome.error })
              } else if (sub.kind === 'emit_finding') {
                const out = await runner.emitFinding(sub, ctx)
                observationIds.push(...out.observationIds)
                evidenceIds.push(...out.evidenceIds)
                childResults.push({ status: 'succeeded' })
              } else if (sub.kind === 'request_handoff') {
                await runner.runHandoff(sub, ctx)
                childResults.push({ status: 'succeeded' })
              } else if (sub.kind === 'if') {
                // Recursive: nested if → record as succeeded (the
                // recursive dispatch above will run its branch).
                childResults.push({ status: 'succeeded' })
              }
            } catch (err) {
              childResults.push({ status: 'failed', error: (err as Error).message })
            }
          }
          const failed = childResults.some((c) => c.status === 'failed')
          const cancelled = childResults.some((c) => c.status === 'cancelled')
          // §round-3 audit fix — TypedStepOutcome.status allows
          // 'skipped' but the parent 'if' status is one of
          // succeeded/failed/cancelled. Map any child 'skipped' to
          // 'succeeded' here so the union stays valid.
          const status: 'succeeded' | 'failed' | 'cancelled' = cancelled
            ? 'cancelled'
            : failed
              ? 'failed'
              : 'succeeded'
          // Note: TypedStepOutcome allows 'skipped' as a valid status
          // for branch children that are gated out, but the parent
          // 'if' itself is one of {succeeded, failed, cancelled}.
          // Record the parent + one outcome per child so stepOutcomes
          // covers every executed step.
          outcomes.push({ stepId: step.id, status, durationMs: Date.now() - start, executions: [] })
          for (const [i, sub] of branch.entries()) {
            const r = childResults[i]!
            outcomes.push({
              stepId: `${step.id}:${sub.id}`,
              status: r.status,
              durationMs: 0,
              executions: [],
              error: r.error,
            })
            if (r.status === 'succeeded') completed.add(`${step.id}:${sub.id}`)
          }
          return { step, status, executions: [], durationMs: Date.now() - start }
        }
        if (step.kind === 'emit_finding') {
          const start = Date.now()
          const out = await runner.emitFinding(step, ctx)
          observationIds.push(...out.observationIds)
          evidenceIds.push(...out.evidenceIds)
          // §round-3 audit fix — record an outcome for emit_finding so
          // the workflow status derivation sees the step succeeded.
          outcomes.push({ stepId: step.id, status: 'succeeded', durationMs: Date.now() - start, executions: [] })
          completed.add(step.id)
          return { step, status: 'succeeded' as const, executions: [], durationMs: Date.now() - start }
        }
        if (step.kind === 'request_handoff') {
          const start = Date.now()
          await runner.runHandoff(step, ctx)
          // §round-3 audit fix — record an outcome.
          outcomes.push({ stepId: step.id, status: 'succeeded', durationMs: Date.now() - start, executions: [] })
          completed.add(step.id)
          return { step, status: 'succeeded' as const, executions: [], durationMs: Date.now() - start }
        }
        // tool
        const attemptId = ctx.issueAttemptId()
        const r = await runStepWithRetry(step, ctx, runner, attemptId)
        return { step, status: r.outcome.status, executions: r.outcome.executions, durationMs: r.outcome.durationMs, error: r.outcome.error, attemptId: r.outcome.attemptId }
      }),
    )
    for (const [i, r] of results.entries()) {
      const step = ready[i]!
      if (r.status === 'fulfilled') {
        const v = r.value
        if (v.status === 'succeeded') {
          completed.add(step.id)
          if (step.kind === 'tool') {
            outcomes.push({ stepId: step.id, status: 'succeeded', durationMs: v.durationMs, executions: v.executions, attemptId: v.attemptId })
          }
        } else if (v.status === 'cancelled') {
          outcomes.push({ stepId: step.id, status: 'cancelled', durationMs: v.durationMs, executions: v.executions, error: v.error })
          stoppedEarly = true
        } else {
          outcomes.push({ stepId: step.id, status: 'failed', durationMs: v.durationMs, executions: v.executions, error: v.error, attemptId: v.attemptId })
          // Mark descendants as dep-failed per policy.
          const descendants = collectDescendants(step.id, adj)
          for (const d of descendants) depFailure.add(d)
          if (policy === 'abort') stoppedEarly = true
        }
      } else {
        // §round-3 audit fix — abort signal during dispatch becomes
        // 'cancelled', not 'failed'.
        const isAbort = ctx.signal?.aborted === true
        outcomes.push({
          stepId: step.id,
          status: isAbort ? 'cancelled' : 'failed',
          durationMs: 0,
          error: isAbort ? 'aborted' : (r.reason as Error).message,
          executions: [],
        })
        if (isAbort) {
          stoppedEarly = true
        } else {
          const descendants = collectDescendants(step.id, adj)
          for (const d of descendants) depFailure.add(d)
          if (policy === 'abort') stoppedEarly = true
        }
      }
      // Decrement remaining counter for descendants.
      for (const next of adj.get(step.id) ?? []) {
        const v = (remaining.get(next) ?? 0) - 1
        remaining.set(next, v)
      }
    }
    // After each wave, evaluate stop conditions.
    if (!stoppedEarly) {
      const condCtx: Parameters<typeof evaluateWorkflowCondition>[1] = {
        state: { taskId: ctx.taskId,
          attempts: [],
          hypotheses: [],
          observations: [],
          evidence: [],
          flagCandidates: [],
          artifactIds: [],
        },
        stepOutcomes: stepOutcomesToMap(outcomes),
      }
      for (const cond of workflow.stopConditions) {
        if (evaluateWorkflowCondition(cond, condCtx)) {
          stoppedEarly = true
          matchedStopCondition = cond
          stopReason = cond.type
          break
        }
      }
    }
  }

  // §round-5 audit fix — an empty workflow is `success` (no work to
  // do, no failure). Previously fell through to `failed` because
  // `allOk` was false (empty array doesn't satisfy `.every`).
  if (workflow.steps.length === 0) {
    return {
      workflowId: workflow.id,
      status: 'success',
      startedAt,
      endedAt: new Date().toISOString(),
      stepOutcomes: outcomes,
      stoppedEarly: false,
      observationIds,
      evidenceIds,
      strategyDecisionIds,
    }
  }
  const allOk = outcomes.every((o) => o.status === 'succeeded' || o.status === 'skipped')
  const anyFailed = outcomes.some((o) => o.status === 'failed')
  const anySucceeded = outcomes.some((o) => o.status === 'succeeded')
  const anyCancelled = outcomes.some((o) => o.status === 'cancelled')
  let status: TypedWorkflowRunResult['status']
  if (anyCancelled) status = 'cancelled'
  else if (allOk) status = 'success'
  else if (anySucceeded && anyFailed) status = 'partial'
  else status = 'failed'

  return {
    workflowId: workflow.id,
    status,
    startedAt,
    endedAt: new Date().toISOString(),
    stepOutcomes: outcomes,
    stoppedEarly,
    matchedStopCondition,
    stopReason,
    observationIds,
    evidenceIds,
    strategyDecisionIds,
  }
}

function stepOutcomesToMap(outcomes: TypedStepOutcome[]): Map<string, { status: 'succeeded' | 'failed' | 'cancelled' | 'skipped' }> {
  const m = new Map<string, { status: 'succeeded' | 'failed' | 'cancelled' | 'skipped' }>()
  for (const o of outcomes) {
    m.set(o.stepId, { status: o.status as 'succeeded' | 'failed' | 'cancelled' })
  }
  return m
}

function collectDescendants(rootId: string, adj: Map<string, string[]>): string[] {
  const out: string[] = []
  const queue = [...(adj.get(rootId) ?? [])]
  while (queue.length) {
    const id = queue.shift()!
    if (out.includes(id)) continue
    out.push(id)
    for (const next of adj.get(id) ?? []) queue.push(next)
  }
  return out
}