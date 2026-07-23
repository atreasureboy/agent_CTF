/**
 * ResultMaterializer — Phase 2.1 §十一.
 *
 * Converts a single execution output (Tool / Workflow Step / OneShot /
 * Specialist) into a `MaterializedResult` of typed drafts. The
 * materializer is the ONLY place that parses raw output into
 * Observation / Evidence / SuggestedAction / FlagCandidate drafts.
 *
 * The Materializer:
 *   - does not execute the next step
 *   - does not mutate TaskState
 *   - emits Drafts only; the orchestrator converts them to events
 *   - delegates per-output parsing to ParserRegistry
 *   - falls back to GenericParser when no parser matches
 *   - never uses an LLM
 */

import type { ObservationDraft } from './observation.js'
import type { EvidenceDraft } from './evidence.js'
import type { SuggestedAction } from './suggestedAction.js'
import type { FlagCandidateDraft } from './flagCandidate.js'
import { materializeViaRegistry, type ParserInput, type ParserSelectionInput } from './parserRegistry.js'

export interface MaterializedResult {
  observations: ObservationDraft[]
  evidence: EvidenceDraft[]
  suggestedActions: SuggestedAction[]
  flagCandidateDrafts: FlagCandidateDraft[]
  warnings: string[]
  rawArtifactIds: string[]
  metrics?: {
    durationMs?: number
    outputBytes?: number
    truncated?: boolean
  }
}

export type MaterializableResult =
  | {
      type: 'tool'
      toolId: string
      executionId?: string
      content?: string
      stdoutPath?: string
      stderrPath?: string
      artifactIds: string[]
      exitCode?: number
      isError: boolean
      durationMs?: number
      parserOptions?: Record<string, unknown>
    }
  | {
      type: 'workflow_step'
      workflowId: string
      stepId: string
      executionId?: string
      content?: string
      stdoutPath?: string
      stderrPath?: string
      artifactIds: string[]
      isError: boolean
      durationMs?: number
    }
  | {
      type: 'oneshot'
      manifestId: string
      oneShotRunId: string
      content?: string
      stdoutPath?: string
      stderrPath?: string
      artifactIds: string[]
      parserId?: string
      exitCode?: number
      isError: boolean
      durationMs?: number
    }
  | {
      type: 'specialist'
      handoffId: string
      agentRunId: string
      content?: string
      artifactIds: string[]
      isError: boolean
      durationMs?: number
    }

export function selectParsersFor(result: MaterializableResult): ParserSelectionInput {
  switch (result.type) {
    case 'tool':
      return { toolId: result.toolId }
    case 'workflow_step':
      return { workflowId: result.workflowId, stepId: result.stepId }
    case 'oneshot':
      return { manifestId: result.manifestId }
    case 'specialist':
      return { workflowId: `specialist:${result.handoffId}` }
  }
}

export function toParserInput(
  taskId: string,
  result: MaterializableResult,
): ParserInput {
  const source: ParserInput['source'] =
    result.type === 'tool' ? { type: 'tool', toolId: result.toolId }
    : result.type === 'oneshot' ? { type: 'oneshot', oneShotRunId: result.oneShotRunId }
    : result.type === 'workflow_step' ? { type: 'workflow', workflowId: result.workflowId, stepId: result.stepId }
    : { type: 'specialist', handoffId: result.handoffId, agentRunId: result.agentRunId }
  const stdoutPath = result.type === 'specialist' ? undefined : result.stdoutPath
  const stderrPath = result.type === 'specialist' ? undefined : result.stderrPath
  const exitCode = 'exitCode' in result ? result.exitCode : undefined
  return {
    taskId,
    source,
    content: result.content,
    stdoutPath,
    stderrPath,
    artifactIds: result.artifactIds,
    exitCode,
    isError: result.isError,
    parserOptions: result.type === 'tool' ? result.parserOptions : undefined,
  }
}

export async function materialize(
  taskId: string,
  result: MaterializableResult,
): Promise<MaterializedResult> {
  const selection = selectParsersFor(result)
  const input = toParserInput(taskId, result)
  return materializeViaRegistry(selection, input, result.durationMs)
}