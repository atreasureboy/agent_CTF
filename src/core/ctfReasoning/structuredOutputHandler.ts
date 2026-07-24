/**
 * StructuredOutputHandler — Phase 2.3 §十.
 *
 * One entry-point that four execution paths (Main Agent, Workflow,
 * OneShot, Specialist) call after their run completes. The handler:
 *
 *   1. Validates the Run Output ids belong to the current task.
 *   2. Deduplicates ids.
 *   3. Invokes `processNewReasoningInputs` with the structured
 *      ids and a fresh `cascadeId` (unless suppressed).
 *   4. Returns the ReasoningResult for the caller (or null when the
 *      auto-trigger was suppressed / already processed).
 *
 * The Handler is the ONLY path that drives ReasoningCoordinator from
 * production code.
 */

import {
  processNewReasoningInputs,
  type ProcessReasoningInputsInput,
  type ReasoningCoordinatorOptions,
} from './reasoningCoordinator.js'
import {
  createCascadeContext,
  ProcessedOutputRegistry,
  REASONING_CASCADE_MAX_DEPTH,
  type ReasoningCascadeContext,
} from './reasoningCascade.js'
import {
  buildStructuredRunOutput,
  dedupeRunOutputIds,
  type StructuredRunOutput,
  type ReasoningInputSource,
} from './structuredRunOutput.js'
import type { ReasoningResult } from './actionExecutionResult.js'
import type { CTFTaskStateStore } from '../ctfRuntime/taskStateStore.js'
import type { CTFTaskState } from '../ctfRuntime/taskState.js'

export interface StructuredOutputHandlerDeps {
  store: CTFTaskStateStore
  registry: ProcessedOutputRegistry
  resolveCoordinatorOptions: () => Omit<ReasoningCoordinatorOptions, 'taskId' | 'state' | 'store'>
  /** Optional override — production callers may suppress auto-reasoning
   *  for a given source (e.g. when the cascade already drained the
   *  child run's output). */
  suppressAutomaticTrigger?: boolean
}

export interface StructuredOutputHandlerOptions {
  autoReason: boolean
  cascade?: ReasoningCascadeContext
}

export class StructuredOutputHandler {
  constructor(private readonly deps: StructuredOutputHandlerDeps) {}

  async handle(
    output: StructuredRunOutput,
    options: StructuredOutputHandlerOptions,
  ): Promise<ReasoningResult | null> {
    const deduped = dedupeRunOutputIds(output)
    // Validate ids belong to this task.
    if (deduped.taskId !== this.deps.store.getState().taskId) {
      throw new Error(
        `StructuredOutputHandler: output taskId=${deduped.taskId} ` +
          `does not match active task=${this.deps.store.getState().taskId}`,
      )
    }

    // Cascade dedup.
    const cascade = options.cascade ?? createCascadeContext()
    this.deps.registry.begin(cascade)
    try {
      // Build the run-id that identifies this output.
      const runId = primaryRunId(deduped)
      if (runId && !options.cascade && this.deps.registry.processedByAny(runId)) {
        // Already processed at least once — skip.
        return null
      }
      if (runId) this.deps.registry.markProcessed(runId, cascade.cascadeId)

      if (cascade.depth >= REASONING_CASCADE_MAX_DEPTH) {
        return null
      }
      if (!options.autoReason || this.deps.suppressAutomaticTrigger || cascade.suppressAutomaticTrigger) {
        return null
      }
      const input: ProcessReasoningInputsInput = {
        source: sourceOf(deduped.source),
        newObservationIds: deduped.observationIds,
        newEvidenceIds: deduped.evidenceIds,
        suggestedActions: deduped.suggestedActions,
        runContext: runContextOf(deduped.source),
        cascade,
      }
      const opts = this.deps.resolveCoordinatorOptions()
      const liveState = this.deps.store.getState()
      const liveTaskId = liveState.taskId
      return await processNewReasoningInputs(
        { ...opts, taskId: liveTaskId, state: liveState, store: this.deps.store },
        input,
      )
    } finally {
      this.deps.registry.end()
    }
  }

  /** Convenience: build the output from raw inputs. */
  async handleRaw(
    args: Parameters<typeof buildStructuredRunOutput>[0],
    options: StructuredOutputHandlerOptions,
  ): Promise<ReasoningResult | null> {
    return this.handle(buildStructuredRunOutput(args), options)
  }
}

function primaryRunId(o: StructuredRunOutput): string {
  switch (o.source.type) {
    case 'main-agent': return o.source.agentRunId
    case 'workflow':   return o.source.workflowRunId
    case 'oneshot':    return o.source.oneShotRunId
    case 'specialist': return o.source.handoffId
  }
}

function sourceOf(src: StructuredRunOutput['source']): ReasoningInputSource {
  return src.type
}

function runContextOf(src: StructuredRunOutput['source']): {
  agentRunId?: string; workflowRunId?: string; oneShotRunId?: string; handoffId?: string
} {
  switch (src.type) {
    case 'main-agent': return { agentRunId: src.agentRunId }
    case 'workflow':   return { workflowRunId: src.workflowRunId }
    case 'oneshot':    return { oneShotRunId: src.oneShotRunId }
    case 'specialist': return { agentRunId: src.agentRunId, handoffId: src.handoffId }
  }
}