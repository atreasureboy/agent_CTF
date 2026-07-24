/**
 * StructuredRunOutput — Phase 2.3 §二十二.
 *
 * Canonical structured result emitted by every task-level execution
 * path:
 *   - Main Agent turn
 *   - Workflow run
 *   - OneShot run
 *   - Specialist (Handoff) run
 *
 * Every auto-reasoning trigger receives one of these. The Handler
 * validates that all IDs belong to the current task and de-duplicates
 * before adding them to the reasoning loop.
 */

import type { SuggestedAction } from './suggestedAction.js'

export type ReasoningInputSource = 'main-agent' | 'workflow' | 'oneshot' | 'specialist' | 'manual'

export interface StructuredRunOutput {
  taskId: string
  source:
    | { type: 'main-agent'; agentRunId: string }
    | { type: 'workflow'; workflowRunId: string }
    | { type: 'oneshot'; oneShotRunId: string }
    | { type: 'specialist'; agentRunId: string; handoffId: string }

  observationIds: string[]
  evidenceIds: string[]
  artifactIds: string[]
  flagCandidateIds: string[]

  suggestedActions: SuggestedAction[]

  status: 'completed' | 'partial' | 'failed' | 'cancelled'
  warnings: string[]
}

export function buildStructuredRunOutput(
  input: Omit<StructuredRunOutput, 'status'> & { status?: StructuredRunOutput['status'] },
): StructuredRunOutput {
  return { ...input, status: input.status ?? 'completed' }
}

export function dedupeRunOutputIds(out: StructuredRunOutput): StructuredRunOutput {
  const dedupe = <T>(arr: readonly T[]): T[] => [...new Set(arr)]
  return {
    ...out,
    observationIds: dedupe(out.observationIds),
    evidenceIds: dedupe(out.evidenceIds),
    artifactIds: dedupe(out.artifactIds),
    flagCandidateIds: dedupe(out.flagCandidateIds),
    suggestedActions: out.suggestedActions,
  }
}
