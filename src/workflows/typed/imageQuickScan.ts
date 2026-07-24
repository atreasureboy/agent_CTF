/**
 * image_quick_scan — Phase 2.1 §二十六 / Phase 2.2 §十三.
 *
 * Typed DAG. Steps in parallel where independent.
 *
 *   file (no deps)
 *   exiftool (depends on file)
 *   strings (depends on file)
 *   binwalk (depends on file)
 *   zsteg (depends on file)
 *
 *   materialize (depends on exiftool AND strings)
 *   conditional-zsteg-decision (depends on zsteg, binwalk)
 *   emit-summary (depends on materialize AND conditional-zsteg-decision)
 *
 * Stop Conditions (§十三):
 *   - flag_candidate_exists (validated)
 *   - artifact_exists (binwalk extracted an archive THIS workflow run,
 *     producedByStepId='binwalk-extract', after the workflow started)
 *   - step_succeeded 'request-image-stego-handoff'
 *
 * The previous `artifact_exists` (no fields) was too wide — any
 * artifact in state would stop the workflow, including the input
 * image. The new condition requires the artifact to come from
 * `binwalk-extract` in the current run.
 */

import type { TypedWorkflowDefinition } from '../../core/workflowDefinition.js'
import type { WorkflowCondition } from '../../core/ctfReasoning/workflowCondition.js'

const flagValidated: WorkflowCondition = { type: 'flag_candidate_exists', validated: true }
const archiveExtracted: WorkflowCondition = {
  type: 'artifact_exists',
  producedByStepId: 'binwalk-extract',
  producedByWorkflowRunId: '$current',
  minCreatedAt: '$workflowStartedAt',
}
const handoffRequested: WorkflowCondition = {
  type: 'step_succeeded',
  stepId: 'request-image-stego-handoff',
}

export const IMAGE_QUICK_SCAN_TYPED: TypedWorkflowDefinition = {
  id: 'image_quick_scan',
  displayName: 'Image quick scan (typed)',
  description: 'Migrated DAG — typed WorkflowCondition + dependsOn + suggested handoffs',
  legacy: false,
  executionMode: 'dag',
  inputs: ['FILE_INPUT'],
  stopConditions: [flagValidated, archiveExtracted, handoffRequested],
  steps: [
    {
      id: 'file',
      kind: 'tool',
      toolId: 'file',
      dependsOn: [],
      emit_finding: false,
      inputs: { FILE_INPUT: { ref: '$FILE_INPUT' } },
    },
    {
      id: 'exiftool',
      kind: 'tool',
      toolId: 'exiftool',
      dependsOn: ['file'],
      emit_finding: false,
      inputs: { FILE_INPUT: { ref: '$FILE_INPUT' } },
    },
    {
      id: 'strings',
      kind: 'tool',
      toolId: 'strings',
      dependsOn: ['file'],
      emit_finding: false,
      inputs: { FILE_INPUT: { ref: '$FILE_INPUT' } },
    },
    {
      id: 'binwalk',
      kind: 'tool',
      toolId: 'binwalk',
      dependsOn: ['file'],
      emit_finding: false,
      inputs: { FILE_INPUT: { ref: '$FILE_INPUT' } },
    },
    {
      id: 'zsteg',
      kind: 'tool',
      toolId: 'zsteg',
      dependsOn: ['file'],
      emit_finding: false,
      inputs: { FILE_INPUT: { ref: '$FILE_INPUT' } },
    },
    {
      id: 'materialize',
      kind: 'if',
      condition: {
        type: 'all',
        conditions: [
          { type: 'step_succeeded', stepId: 'exiftool' },
          { type: 'step_succeeded', stepId: 'strings' },
        ],
      },
      then: [
        {
          id: 'materialize-image',
          kind: 'tool',
          toolId: 'materialize-image',
          dependsOn: [],
          emit_finding: false,
        },
      ],
      else: [],
      dependsOn: ['file'],
    },
    {
      id: 'conditional-zsteg-decision',
      kind: 'if',
      condition: {
        type: 'evidence_exists',
        kind: 'negative_result',
        scope: { workflowRunId: '$current', stepId: 'zsteg' },
        minConfidence: 0.5,
      },
      then: [
        {
          id: 'request-image-stego-handoff',
          kind: 'request_handoff',
          capability: 'image-stego',
          dependsOn: [],
          emit_finding: false,
        },
      ],
      else: [],
      dependsOn: ['zsteg'],
    },
    {
      id: 'emit-summary',
      kind: 'emit_finding',
      dependsOn: ['materialize', 'conditional-zsteg-decision'],
      fromObservations: {
        kinds: ['metadata', 'embedded_data', 'printable_text'],
        minConfidence: 0.4,
      },
      fromEvidence: { minConfidence: 0.4 },
      includeSuggestedActions: true,
    },
  ],
}
