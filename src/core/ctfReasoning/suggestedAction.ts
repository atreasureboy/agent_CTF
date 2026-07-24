/**
 * SuggestedAction — Phase 2.1 §十五.
 *
 * Discriminated union of actions a parser or workflow may suggest.
 * They cannot execute directly — the StrategyPlanner + ToolSelectionPolicy
 * + AttemptDeduplicator + CostPolicy must approve, then the Orchestrator
 * or Workflow Runtime acts.
 */

export type CostTier = 'cheap' | 'normal' | 'expensive'

interface BaseAction {
  reason: string
  priority: number
  costTier: CostTier
  hypothesisIds?: string[]
}

export type SuggestedAction =
  | (BaseAction & {
      type: 'run_workflow'
      workflowId: string
      inputs: Record<string, unknown>
    })
  | (BaseAction & {
      type: 'run_oneshot'
      manifestId: string
      inputArtifactIds: string[]
      options?: Record<string, unknown>
    })
  | (BaseAction & {
      type: 'call_tool'
      toolId: string
      input: Record<string, unknown>
    })
  | (BaseAction & {
      type: 'request_handoff'
      capability: string
      objective: string
      artifactIds: string[]
      findingIds?: string[]
      observationIds?: string[]
      evidenceIds?: string[]
    })
  | (BaseAction & {
      type: 'verify_flag'
      candidateId: string
    })
  | (BaseAction & {
      type: 'stop'
    })
