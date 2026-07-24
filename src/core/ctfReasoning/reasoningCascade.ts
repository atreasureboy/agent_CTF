/**
 * ReasoningCascade — Phase 2.3 §九.
 *
 * Cascade context + processed-output registry that prevents recursive
 * re-triggering of ReasoningCoordinator while a run output is being
 * consumed.
 *
 * Rules:
 *   1. The Coordinator enters via `withCascadeLock(ctx, fn)`; nested
 *      calls collapse into the same cascade.
 *   2. When the Coordinator issues a child run (run_workflow, run_oneshot,
 *      handoff), the executor returns with
 *      `executionRefs.<runKind/RunId>` populated. The Coordinator
 *      records the child runId in `processedCascadeIds` so the
 *      orchestrator's auto-trigger hook checks the registry before
 *      re-entering.
 *   3. `depth` is incremented by 1 per cascade. `MAX_DEPTH = 8` is the
 *      hard upper bound.
 */

import { randomBytes } from 'crypto'

export const REASONING_CASCADE_MAX_DEPTH = 8

export interface ReasoningCascadeContext {
  cascadeId: string
  depth: number
  parentStrategyDecisionId?: string
  parentAttemptId?: string
  /** When true, the Executor that ran the child Action bypasses
   *  auto-trigger. */
  suppressAutomaticTrigger: boolean
}

export function createCascadeContext(
  overrides: Partial<ReasoningCascadeContext> = {},
): ReasoningCascadeContext {
  return {
    cascadeId: overrides.cascadeId ?? `csc_${randomBytes(6).toString('hex')}`,
    depth: overrides.depth ?? 0,
    parentStrategyDecisionId: overrides.parentStrategyDecisionId,
    parentAttemptId: overrides.parentAttemptId,
    suppressAutomaticTrigger: overrides.suppressAutomaticTrigger ?? false,
  }
}

export interface ReasoningExecutionContext {
  taskId: string
  strategyDecisionId: string
  attemptId: string
  cascadeId: string
  reasoningDepth: number
  sourceAgentRunId?: string
  sourceWorkflowRunId?: string
  sourceOneShotRunId?: string
  sourceHandoffId?: string
}

/** Per-task processed output registry. Lives on the Orchestrator
 *  instance, NOT in module-level memory. */
export class ProcessedOutputRegistry {
  /** Maps runId → set of cascadeIds that already processed it. */
  private readonly processed = new Map<string, Set<string>>()
  /** Cascade stack — pushes on entry, pops on exit. */
  private readonly stack: ReasoningCascadeContext[] = []

  begin(cascade: ReasoningCascadeContext): void {
    this.stack.push(cascade)
  }

  end(): ReasoningCascadeContext | undefined {
    return this.stack.pop()
  }

  current(): ReasoningCascadeContext | undefined {
    return this.stack[this.stack.length - 1]
  }

  /** Mark `runId` as processed by `cascadeId`. Returns true if this
   *  is the first time → caller should run the hook; false if
   *  already processed → caller should skip. */
  markProcessed(runId: string, cascadeId: string): boolean {
    let set = this.processed.get(runId)
    if (!set) {
      set = new Set()
      this.processed.set(runId, set)
    }
    if (set.has(cascadeId)) return false
    set.add(cascadeId)
    return true
  }

  /** True when the current cascade already processed the given
   *  runId. */
  hasProcessed(runId: string): boolean {
    const cs = this.stack[this.stack.length - 1]
    if (!cs) return false
    const set = this.processed.get(runId)
    return !!set && set.has(cs.cascadeId)
  }

  /** True when ANY cascade has processed the runId. */
  processedByAny(runId: string): boolean {
    return (this.processed.get(runId)?.size ?? 0) > 0
  }

  reset(): void {
    this.processed.clear()
    this.stack.length = 0
  }
}