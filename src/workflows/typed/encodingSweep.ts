/**
 * encoding_sweep — Phase 2.1 §二十七 / Phase 2.2 §十四.
 *
 * Bounded decode tree. Limits:
 *   - maxDepth: 4
 *   - maxBranchesPerDepth: 8
 *   - maxTotalAttempts: 24
 *   - maxOutputBytesPerNode: 1_048_576
 *
 * No infinite recursion. Same outputHash dedupes.
 * Steps:
 *   - charset-analysis (no deps)
 *   - decode-tree (depends on charset-analysis, runs as a single
 *     bounded step that internally walks the codec tree)
 *   - candidate-extraction (depends on decode-tree)
 *   - emit-summary (depends on candidate-extraction)
 *
 * Stop Conditions (§十四):
 *   - flag_candidate_exists (validated)
 *   - decode-tree reported no new unique outputs (specific evidence
 *     kind=negative_result, attributes.reason=no_new_unique_output,
 *     scoped to current workflowRunId / stepId=decode-tree)
 *   - decode-tree reached maxDepth (specific evidence
 *     attributes.reason=max_depth_reached, same scope)
 *
 * These conditions MUST scope to the current workflow run; older
 * runs' negative_result Evidence cannot trigger this workflow's stop.
 */

import type { TypedWorkflowDefinition } from '../../core/workflowDefinition.js'
import type { WorkflowCondition } from '../../core/ctfReasoning/workflowCondition.js'

const flagValidated: WorkflowCondition = { type: 'flag_candidate_exists', validated: true }
const noNewOutputs: WorkflowCondition = {
  type: 'evidence_exists',
  kind: 'negative_result',
  scope: { workflowRunId: '$current', stepId: 'decode-tree' },
  where: { reason: 'no_new_unique_output' },
  minConfidence: 0.5,
}
const maxDepthReached: WorkflowCondition = {
  type: 'evidence_exists',
  kind: 'negative_result',
  scope: { workflowRunId: '$current', stepId: 'decode-tree' },
  where: { reason: 'max_depth_reached' },
  minConfidence: 0.6,
}

export const ENCODING_SWEEP_TYPED: TypedWorkflowDefinition = {
  id: 'encoding_sweep',
  displayName: 'Encoding sweep (typed)',
  description: 'Bounded decode tree with maxDepth / maxBranches / maxAttempts caps',
  legacy: false,
  executionMode: 'dag',
  inputs: ['TEXT_INPUT'],
  stopConditions: [flagValidated, noNewOutputs, maxDepthReached],
  steps: [
    {
      id: 'charset-analysis',
      kind: 'tool',
      toolId: 'encoding-detect',
      dependsOn: [],
      emit_finding: false,
    },
    {
      id: 'decode-tree',
      kind: 'tool',
      toolId: 'decode-tree',
      dependsOn: ['charset-analysis'],
      emit_finding: false,
      inputs: {
        TEXT_INPUT: { ref: '$TEXT_INPUT' },
        maxDepth: 4,
        maxBranchesPerDepth: 8,
        maxTotalAttempts: 24,
        maxOutputBytesPerNode: 1048576,
      },
    },
    {
      id: 'candidate-extraction',
      kind: 'tool',
      toolId: 'extract-candidates',
      dependsOn: ['decode-tree'],
      emit_finding: false,
    },
    {
      id: 'emit-summary',
      kind: 'emit_finding',
      dependsOn: ['candidate-extraction'],
      fromObservations: { kinds: ['encoding_result'], minConfidence: 0.5 },
      fromEvidence: { kinds: ['encoding_layer'], minConfidence: 0.5 },
      includeSuggestedActions: false,
    },
  ],
}
