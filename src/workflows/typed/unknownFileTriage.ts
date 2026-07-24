/**
 * unknown_file_triage — Phase 2.1 §二十五.
 *
 * Migrated to typed WorkflowCondition. DAG with `dependsOn`:
 *
 *   identify-file (no deps)
 *     ├── read-magic (depends on identify-file)
 *     ├── extract-strings (depends on identify-file)
 *     └── entropy (depends on identify-file)
 *
 *   classify (depends on read-magic AND extract-strings)
 *   emit-summary (depends on classify)
 *
 * Stop Conditions (typed):
 *   - flag_candidate_exists (validated)
 *   - artifact_exists (an extracted archive was produced)
 *   - any: workflow completed all steps (no candidate + no extraction)
 */

import type { TypedWorkflowDefinition } from '../../core/workflowDefinition.js'
import type { WorkflowCondition } from '../../core/ctfReasoning/workflowCondition.js'
import { evaluateWorkflowCondition } from '../../core/ctfReasoning/workflowCondition.js'

const flagCandidateExists: WorkflowCondition = {
  type: 'flag_candidate_exists',
  validated: true,
}

const archiveProduced: WorkflowCondition = {
  type: 'artifact_exists',
}

const allStepsSucceeded: WorkflowCondition = {
  type: 'all',
  conditions: [
    { type: 'step_succeeded', stepId: 'identify-file' },
    { type: 'step_succeeded', stepId: 'classify' },
    { type: 'step_succeeded', stepId: 'emit-summary' },
  ],
}

export function isMigratedUnknownFileTriageStop(
  ctx: Parameters<typeof evaluateWorkflowCondition>[1],
): { stopped: boolean; reason: string | undefined } {
  for (const cond of [flagCandidateExists, archiveProduced, allStepsSucceeded]) {
    if (evaluateWorkflowCondition(cond, ctx)) {
      const reason =
        cond.type === 'flag_candidate_exists'
          ? 'flag_candidate_validated'
          : cond.type === 'artifact_exists'
            ? 'archive_extracted'
            : 'all_steps_succeeded'
      return { stopped: true, reason }
    }
  }
  return { stopped: false, reason: undefined }
}

export const UNKNOWN_FILE_TRIAGE_TYPED: TypedWorkflowDefinition = {
  id: 'unknown_file_triage',
  displayName: 'Unknown file triage (typed)',
  description: 'Migrated DAG — typed WorkflowCondition + dependsOn + stop conditions',
  legacy: false,
  executionMode: 'dag',
  inputs: ['FILE_INPUT'],
  stopConditions: [flagCandidateExists, archiveProduced, allStepsSucceeded],
  steps: [
    {
      id: 'identify-file',
      kind: 'tool',
      toolId: 'file',
      inputs: { FILE_INPUT: { ref: '$FILE_INPUT' } },
      dependsOn: [],
      emit_finding: false,
    },
    {
      id: 'read-magic',
      kind: 'tool',
      toolId: 'hex_header',
      inputs: { FILE_INPUT: { ref: '$FILE_INPUT' } },
      dependsOn: ['identify-file'],
      emit_finding: false,
    },
    {
      id: 'extract-strings',
      kind: 'tool',
      toolId: 'strings',
      inputs: { FILE_INPUT: { ref: '$FILE_INPUT' } },
      dependsOn: ['identify-file'],
      emit_finding: false,
    },
    {
      id: 'entropy',
      kind: 'tool',
      toolId: 'entropy',
      inputs: { FILE_INPUT: { ref: '$FILE_INPUT' } },
      dependsOn: ['identify-file'],
      emit_finding: false,
    },
    {
      id: 'classify',
      kind: 'if',
      condition: {
        type: 'all',
        conditions: [
          { type: 'step_succeeded', stepId: 'read-magic' },
          { type: 'step_succeeded', stepId: 'extract-strings' },
        ],
      },
      then: [
        {
          id: 'classify-image',
          kind: 'tool',
          toolId: 'classify-by-type',
          dependsOn: [],
          emit_finding: false,
        },
      ],
      else: [
        {
          id: 'classify-unknown',
          kind: 'tool',
          toolId: 'classify-unknown',
          dependsOn: [],
          emit_finding: false,
        },
      ],
      dependsOn: ['identify-file'],
    },
    {
      id: 'emit-summary',
      kind: 'emit_finding',
      dependsOn: ['classify'],
      fromEvidence: { minConfidence: 0.5 },
      fromObservations: { minConfidence: 0.5 },
      includeSuggestedActions: true,
    },
  ],
}
