/**
 * encoding_sweep — Phase 2.1 §二十七.
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
 * Stop Conditions:
 *   - flag_candidate_exists (validated)
 *   - decode-tree reached maxDepth without new outputHash
 */

import type { TypedWorkflowDefinition } from '../../core/workflowDefinition.js'
import type { WorkflowCondition } from '../../core/ctfReasoning/workflowCondition.js'

const flagValidated: WorkflowCondition = { type: 'flag_candidate_exists', validated: true }
const noNewOutputs: WorkflowCondition = {
  type: 'evidence_exists',
  kind: 'negative_result',
  minConfidence: 0.5,
}
const maxDepthReached: WorkflowCondition = {
  type: 'evidence_exists',
  kind: 'generic',
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
    { id: 'charset-analysis', kind: 'tool', toolId: 'encoding-detect', dependsOn: [], emit_finding: false },
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
    { id: 'candidate-extraction', kind: 'tool', toolId: 'extract-candidates', dependsOn: ['decode-tree'], emit_finding: false },
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