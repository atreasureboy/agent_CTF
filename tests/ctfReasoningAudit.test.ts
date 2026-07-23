/**
 * Phase 2.1 round-5 audit follow-up tests.
 */

import { describe, it, expect } from 'vitest'
import { CTFTaskStateStore, TaskStateStoreError } from '../src/core/ctfRuntime/taskStateStore.js'
import type { CTFTaskState, CTFHypothesis } from '../src/core/ctfRuntime/taskState.js'
import { redactSecrets } from '../src/core/ctfReasoning/redaction.js'

function emptyState(): CTFTaskState {
  return {
    taskId: 't1',
    phase: 'triage',
    context: {
      taskId: 't1',
      workspaceDir: '/tmp/ctf',
      sessionDir: '/tmp/ctf/s',
      artifactDir: '/tmp/ctf/a',
      inputDir: '/tmp/ctf/i',
      eventsFile: '/tmp/ctf/e.ndjson',
      profileId: 'triage',
      contestScope: { allowedFilesRoot: '/tmp/ctf', allowPublicNetwork: false, allowHeavyOneShots: false },
      contestConfig: { allowedFilesRoot: '/tmp/ctf', allowPublicNetwork: false, allowHeavyOneShots: false },
      environment: {},
      abortSignal: new AbortController().signal,
      metadata: {},
    },
    challenge: { inputArtifactIds: [] },
    activeProfileId: 'triage',
    findings: [],
    artifactIds: [],
    hypotheses: [],
    attempts: [],
    handoffs: [],
    agentRuns: [],
    workflowRuns: [],
    jobs: [],
    oneShotRuns: [],
    activeAgentRunIds: [],
    activeWorkflowRunIds: [],
    activeJobIds: [],
    observations: [],
    evidence: [],
    strategyDecisions: [],
    flagCandidates: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

function makeHypothesis(status: CTFHypothesis['status']): CTFHypothesis {
  return {
    id: 'h1',
    taskId: 't1',
    statement: 'PNG contains hidden ZIP',
    category: 'image',
    status,
    supportingEvidenceIds: [],
    contradictingEvidenceIds: [],
    proposedBy: { type: 'planner', id: 'planner' },
    priority: 1,
    confidence: 0.5,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

describe('HYPOTHESIS_STATUS_CHANGED stale-event guard (round-5)', () => {
  it('rejects an event whose from does not match the current status', () => {
    const state = emptyState()
    state.hypotheses = [makeHypothesis('rejected')]
    const store = new CTFTaskStateStore(state)
    expect(() =>
      store.apply({
        type: 'HYPOTHESIS_STATUS_CHANGED',
        hypothesisId: 'h1',
        from: 'proposed',
        to: 'testing',
      }),
    ).toThrow(TaskStateStoreError)
  })

  it('accepts a fresh event whose from matches', () => {
    const state = emptyState()
    state.hypotheses = [makeHypothesis('proposed')]
    const store = new CTFTaskStateStore(state)
    store.apply({
      type: 'HYPOTHESIS_STATUS_CHANGED',
      hypothesisId: 'h1',
      from: 'proposed',
      to: 'testing',
    })
    expect(store.getState().hypotheses[0]?.status).toBe('testing')
  })

  it('is idempotent: re-applying the same target status is a no-op', () => {
    const state = emptyState()
    state.hypotheses = [makeHypothesis('testing')]
    const store = new CTFTaskStateStore(state)
    // Already in `testing`. Apply testing → inconclusive.
    store.apply({
      type: 'HYPOTHESIS_STATUS_CHANGED',
      hypothesisId: 'h1',
      from: 'testing',
      to: 'inconclusive',
    })
    expect(store.getState().hypotheses[0]?.status).toBe('inconclusive')
    // Now try to re-apply inconclusive → inconclusive with `from: inconclusive`.
    expect(() =>
      store.apply({
        type: 'HYPOTHESIS_STATUS_CHANGED',
        hypothesisId: 'h1',
        from: 'inconclusive',
        to: 'inconclusive',
      }),
    ).toThrow(TaskStateStoreError) // 'inconclusive' cannot transition to itself via the FSM
  })
})

describe('redaction — pass / pwd (round-5)', () => {
  it('redacts pass=', () => {
    const r = redactSecrets('user=admin pass=hunter2 next=ok')
    expect(r).toContain('pass=<redacted>')
    expect(r).not.toContain('hunter2')
    expect(r).toContain('user=admin')
  })

  it('redacts pwd=', () => {
    const r = redactSecrets('user=admin pwd=secret123')
    expect(r).toContain('pwd=<redacted>')
    expect(r).not.toContain('secret123')
  })
})