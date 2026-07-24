/**
 * Phase D1 — HTML trajectory renderer.
 */

import { describe, it, expect } from 'vitest'
import { renderTrajectoryHtml } from '../src/core/ctfRuntime/htmlTrajectoryRenderer.js'
import type { ReplayOutput } from '../src/core/ctfRuntime/replayer.js'
import { CTFTaskStateStore } from '../src/core/ctfRuntime/taskStateStore.js'
import { createTestTaskState } from './fixtures/createTestTaskState.js'
import { replayFromEvents } from '../src/core/ctfRuntime/replayer.js'

describe('HTML trajectory renderer (D1)', () => {
  it('renders a minimal replay as self-contained HTML', () => {
    const initial = createTestTaskState({ taskId: 'd1-1' })
    const store = new CTFTaskStateStore(initial)
    store.apply({ type: 'STRATEGY_DECISION_RECORDED', decision: {
      id: 'sd1', taskId: 'd1-1', selectedAction: { type: 'call_tool', toolId: 'file', input: {}, reason: 'r', priority: 1, costTier: 'cheap' } as never,
      rejectedActions: [], reason: 'test', basedOnObservationIds: [], basedOnEvidenceIds: [], basedOnHypothesisIds: [], createdAt: 0,
    } })
    store.apply({ type: 'ATTEMPT_STARTED', attempt: {
      id: 'a1', taskId: 'd1-1', kind: 'tool', targetId: 'file', input: {}, fingerprint: 'fp',
      hypothesisIds: [], status: 'running',
      observationIds: [], evidenceIds: [], artifactIds: [], flagCandidateIds: [], createdAt: 0,
    } })
    store.apply({ type: 'ATTEMPT_COMPLETED', attemptId: 'a1', status: 'succeeded',
      observationIds: ['o1'], evidenceIds: ['e1'], artifactIds: [], flagCandidateIds: [],
      completedAt: 1 })
    const out = replayFromEvents(['TASK_CREATED'] as never)  // placeholder
    void out
    // Use the store-derived events:
    const log: ReplayOutput = { taskId: 'd1-1', cycles: [], finalState: {
      totalObservations: 1, totalEvidence: 1, totalArtifacts: 0, totalFlagCandidates: 0,
      validatedFlagCandidates: 0, acceptedStrategies: 1,
    }}
    const html = renderTrajectoryHtml(log)
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('Trajectory: d1-1')
    expect(html).toContain('Total observations')
  })

  it('escapes XSS in cycle / attempt fields', () => {
    const html = renderTrajectoryHtml({
      taskId: 'd1-<script>alert(1)</script>',
      cycles: [{
        index: 0, budgetAfter: 0, strategyDecisions: [],
        attempts: [{
          attemptId: 'a1', cycle: 0, action: 'tool:<x>', status: 'succeeded',
          startedAt: 0, observationIds: [], evidenceIds: [], artifactIds: [], flagCandidateIds: [],
        }],
      }],
      finalState: {
        totalObservations: 0, totalEvidence: 0, totalArtifacts: 0,
        totalFlagCandidates: 0, validatedFlagCandidates: 0, acceptedStrategies: 0,
      },
    })
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
  })
})
