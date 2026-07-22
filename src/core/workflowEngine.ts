/**
 * WorkflowEngine — runtime executor for WorkflowDefinition instances.
 *
 * The Engine takes a definition + a runner (ToolBroker delegate) + a context
 * (task / agent / workspace) and produces a WorkflowRunResult. Steps are
 * dispatched to the runner; if/parallel/sequence are nested types evaluated
 * recursively.
 *
 * Failure policy:
 *   - `partialFailurePolicy: 'continue'` → record failures, keep going.
 *   - `partialFailurePolicy: 'abort'` → terminate on first failure.
 *   - step-level `onFailure: 'retry'` is documented but not implemented in the
 *     first cut; instead treated as 'continue'.
 *
 * Cancellation is supported via AbortSignal — the engine stops dispatching
 * new steps but lets the in-flight step settle.
 */

import type {
  StepOutcome,
  WorkflowDefinition,
  WorkflowRunResult,
  WorkflowStep,
} from './workflowDefinition.js'

export interface WorkflowRunner {
  /** Step runner — returns its output as a string. */
  runStep(
    step: Extract<WorkflowStep, { kind: 'tool' | 'shell' }>,
    ctx: RunContext,
  ): Promise<{ content: string; isError: boolean; artifactIds: string[] }>
  /** Emit a finding through the agent's output channel. */
  emitFinding(
    step: Extract<WorkflowStep, { kind: 'emit_finding' }>,
    ctx: RunContext,
  ): Promise<void>
}

export interface RunContext {
  taskId: string
  agentId: string
  workflowId: string
  inputs: Record<string, unknown>
  capturedOutputs: Map<string, string>
  /**
   * §十三.3 — workflow run id (assigned by the Orchestrator) and
   * originating agent run id, threaded into the RunContext so the
   * broker can attribute emitted findings/artifacts to the producing
   * run. Optional because unit tests and direct callers may not have a
   * Orchestrator-issued id; pass `undefined` for those.
   */
  workflowRunId?: string
  agentRunId?: string
}

export interface EngineOptions {
  signal?: AbortSignal
  /** Defaults to the workflow's `partialFailurePolicy`. */
  partialFailurePolicy?: 'continue' | 'abort'
  /** Defaults to Date.now()/1000 — used in step timestamps. */
  clock?: () => number
}

export class WorkflowEngine {
  constructor(private readonly runner: WorkflowRunner) {}

  async run(
    workflow: WorkflowDefinition,
    ctx: RunContext,
    options: EngineOptions = {},
  ): Promise<WorkflowRunResult> {
    const startedAt = new Date().toISOString()
    const outcomes: StepOutcome[] = []
    const artifactIds = new Set<string>()
    let emittedFindings = 0
    const policy = options.partialFailurePolicy ?? workflow.partialFailurePolicy
    const clock = options.clock ?? Date.now
    const outerSignal = options.signal

    let cancelledEarly = false

    // executionMode dispatch:
    //   - 'sequential' (default): top-level steps run one after another
    //   - 'parallel' / 'dag'    : all top-level steps run concurrently via
    //                             Promise.allSettled (independent steps, no
    //                             explicit dependencies declared; future
    //                             versions may add a `dependsOn` field)
    if (workflow.executionMode === 'parallel' || workflow.executionMode === 'dag') {
      const results = await Promise.allSettled(
        workflow.steps.map((step) =>
          this.dispatch(step, ctx, policy, outerSignal, outcomes, artifactIds, clock)
            .then((status) => {
              if (status === 'cancelled') cancelledEarly = true
              return status
            })
            .catch((err: Error) => {
              outcomes.push({
                stepId: step.id,
                status: 'failed',
                durationMs: 0,
                error: err.message,
              })
              if (policy === 'abort') return 'aborted'
              return 'ok'
            })
        ),
      )
      // count findings
      for (const step of workflow.steps) {
        if (step.kind === 'emit_finding') emittedFindings++
      }
      void results
    } else {
      for (const step of workflow.steps) {
        if (outerSignal?.aborted) {
          cancelledEarly = true
          break
        }
        const start = clock()
        try {
          const nested = await this.dispatch(step, ctx, policy, outerSignal, outcomes, artifactIds, clock)
          if (nested === 'cancelled') {
            cancelledEarly = true
            break
          }
          if (nested === 'aborted') break
        } catch (err) {
          outcomes.push({
            stepId: step.id,
            status: 'failed',
            durationMs: clock() - start,
            error: (err as Error).message,
          })
          if (policy === 'abort') break
        }
        if (step.kind === 'emit_finding') emittedFindings++
      }
    }

    // Evaluate any stopConditions purely descriptively — the engine treats them
    // as advisory in the first cut. Future versions may pre-evaluate.
    return {
      workflowId: workflow.id,
      status: cancelledEarly
        ? 'cancelled'
        : (() => {
            const failed = outcomes.some((o) => o.status === 'failed')
            const succeeded = outcomes.some((o) => o.status === 'success')
            const onlySkipped = outcomes.length > 0 && outcomes.every((o) => o.status === 'skipped')
            if (onlySkipped) return 'success'
            if (failed && succeeded) return 'partial'
            if (succeeded) return 'success'
            if (failed) return 'failed'
            return 'success'
          })(),
      startedAt,
      endedAt: new Date().toISOString(),
      stepOutcomes: outcomes,
      emittedFindingCount: emittedFindings,
      emittedArtifactCount: artifactIds.size,
    }
  }

  private async dispatch(
    step: WorkflowStep,
    ctx: RunContext,
    policy: 'continue' | 'abort',
    outerSignal: AbortSignal | undefined,
    outcomes: StepOutcome[],
    artifactIds: Set<string>,
    clock: () => number,
  ): Promise<'ok' | 'aborted' | 'cancelled'> {
    if (outerSignal?.aborted) return 'cancelled'

    if (step.kind === 'tool' || step.kind === 'shell') {
      const start = clock()
      try {
        const r = await this.runner.runStep(step, ctx)
        for (const id of r.artifactIds) artifactIds.add(id)
        ctx.capturedOutputs.set(step.id, r.content)
        outcomes.push({
          stepId: step.id,
          status: r.isError ? 'failed' : 'success',
          durationMs: clock() - start,
          output: r.content.slice(0, 1500),
          artifactIds: r.artifactIds,
          error: r.isError ? r.content : undefined,
        })
        if (r.isError && policy === 'abort') return 'aborted'
      } catch (err) {
        outcomes.push({
          stepId: step.id,
          status: 'failed',
          durationMs: clock() - start,
          error: (err as Error).message,
        })
        if (policy === 'abort') return 'aborted'
      }
      return 'ok'
    }

    if (step.kind === 'emit_finding') {
      try {
        await this.runner.emitFinding(step, ctx)
      } catch (err) {
        outcomes.push({
          stepId: step.id,
          status: 'failed',
          durationMs: 0,
          error: (err as Error).message,
        })
      }
      return 'ok'
    }

    if (step.kind === 'sequence') {
      for (const s of step.steps) {
        const r = await this.dispatch(s, ctx, policy, outerSignal, outcomes, artifactIds, clock)
        if (r !== 'ok') return r
      }
      return 'ok'
    }

    if (step.kind === 'parallel') {
      const results = await Promise.allSettled(
        step.steps.map((s: WorkflowStep) => this.dispatch(s, ctx, policy, outerSignal, outcomes, artifactIds, clock)),
      )
      if (step.join === 'all') {
        if (results.some((r) => r.status === 'rejected' || (r.status === 'fulfilled' && r.value === 'aborted'))) {
          return 'aborted'
        }
      }
      return 'ok'
    }

    if (step.kind === 'if') {
      // Minimal expression evaluator: supports results.length > 0 / == 'x' /
      // contains 'y' against the captured outputs. Anything unparseable
      // evaluates to false (the engine is conservative by default).
      const cond = this.evaluateCondition(step.when, ctx.capturedOutputs)
      if (!cond) {
        outcomes.push({ stepId: step.id, status: 'skipped', durationMs: 0 })
        return 'ok'
      }
      for (const s of step.then) {
        const r = await this.dispatch(s, ctx, policy, outerSignal, outcomes, artifactIds, clock)
        if (r !== 'ok') return r
      }
      return 'ok'
    }

    return 'ok'
  }

  /** A conservative expression evaluator; intentionally tiny. The shell DSL
   * keeps it auditable. Tests should not depend on complex expressions. */
  private evaluateCondition(expr: string, captured: Map<string, string>): boolean {
    try {
      const trimmed = expr.trim()
      // Operations supported: result.length { > , < , == , != } { number | string }
      const m1 = trimmed.match(/^([\w.-]+)\.length\s*(>|<|==|!=)\s*(\d+)$/)
      if (m1) {
        const [, name, op, n] = m1
        const v = captured.get(name) ?? ''
        const len = v.length
        const rhs = Number(n)
        return this.compare(len, op, rhs)
      }
      const m2 = trimmed.match(/^([\w.-]+)\s*(contains|startsWith|endsWith)\s*['"](.+?)['"]$/)
      if (m2) {
        const [, name, op, lit] = m2
        const v = captured.get(name) ?? ''
        if (op === 'contains') return v.includes(lit)
        if (op === 'startsWith') return v.startsWith(lit)
        if (op === 'endsWith') return v.endsWith(lit)
        return false
      }
      const m3 = trimmed.match(/^([\w.-]+)\s*(==|!=)\s*['"](.+?)['"]$/)
      if (m3) {
        const [, name, op, lit] = m3
        const v = captured.get(name) ?? ''
        return op === '==' ? v === lit : v !== lit
      }
      return false
    } catch {
      return false
    }
  }

  private compare(lhs: number, op: string, rhs: number): boolean {
    if (op === '>') return lhs > rhs
    if (op === '<') return lhs < rhs
    if (op === '==') return lhs === rhs
    if (op === '!=') return lhs !== rhs
    return false
  }
}
