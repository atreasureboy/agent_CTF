/**
 * Phase 2.2 §二十五 — Concurrent Run Condition tests.
 *
 * Verifies that two workflowRuns A / B do not cross-trigger their
 * stop conditions.
 */

import { describe, it, expect } from 'vitest'
import { evaluateWorkflowCondition } from '../src/core/ctfReasoning/workflowCondition.js'
import type { EvidenceKind, EvidencePolarity } from '../src/core/ctfReasoning/evidence.js'
import { createTestTaskState } from './fixtures/createTestTaskState.js'

describe('Phase 2.2 §二十五 — concurrent run conditions', () => {
  it('artifact_exists producedByStep=binwalk-extract only matches the run that produced it', () => {
    const base = createTestTaskState()
    // Old run produced an artifact.
    const stateA = {
      ...base,
      taskId: 't1',
      artifactIds: ['art-old'],
      artifacts: new Map([
        ['art-old', {
          id: 'art-old',
          producedByStepId: 'binwalk-extract',
          producedByWorkflowRunId: 'wf-A',
          createdAt: 1000,
        }],
      ]),
    }
    expect(evaluateWorkflowCondition(
      {
        type: 'artifact_exists',
        producedByStepId: 'binwalk-extract',
        producedByWorkflowRunId: '$current',
        minCreatedAt: '$workflowStartedAt',
      },
      {
        state: { ...stateA, currentWorkflowRunId: 'wf-B', currentWorkflowStartedAt: 2000 },
        stepOutcomes: new Map(),
      },
    )).toBe(false)

    // B's own run produces the artifact after the run started.
    const stateB = {
      ...stateA,
      artifactIds: ['art-old', 'art-new'],
      artifacts: new Map([
        ['art-old', stateA.artifacts!.get('art-old')!],
        ['art-new', {
          id: 'art-new',
          producedByStepId: 'binwalk-extract',
          producedByWorkflowRunId: 'wf-B',
          createdAt: 2500,
        }],
      ]),
    }
    expect(evaluateWorkflowCondition(
      {
        type: 'artifact_exists',
        producedByStepId: 'binwalk-extract',
        producedByWorkflowRunId: '$current',
        minCreatedAt: '$workflowStartedAt',
      },
      {
        state: { ...stateB, currentWorkflowRunId: 'wf-B', currentWorkflowStartedAt: 2000 },
        stepOutcomes: new Map(),
      },
    )).toBe(true)
  })

  it('encoding_sweep stop condition requires a specific reason attribute', () => {
    const base = createTestTaskState()
    const stateWithGenericNegative = {
      ...base,
      taskId: 't1',
      evidence: [
        {
          id: 'e1', taskId: 't1', kind: 'negative_result' as EvidenceKind,
          claim: 'something', normalizedClaim: 'something', polarity: 'supports' as EvidencePolarity,
          confidence: 0.6,
          sources: [{ producer: { type: 'workflow', id: 'decode-tree' }, observationIds: [], artifactIds: [], attemptIds: [], confidence: 0.6, createdAt: 0 }],
          fingerprint: 'fp', attributes: { reason: 'something_else' }, createdAt: 0, updatedAt: 0,
        },
      ],
    }
    // A generic negative_result doesn't satisfy the new specific reason condition.
    expect(evaluateWorkflowCondition(
      {
        type: 'evidence_exists',
        kind: 'negative_result',
        where: { reason: 'no_new_unique_output' },
      },
      {
        state: stateWithGenericNegative,
        stepOutcomes: new Map(),
      },
    )).toBe(false)
  })
})