import { describe, it, expect } from 'vitest'
import { replayFromJsonl, replayFromEvents } from '../src/core/ctfRuntime/replayer.js'
import { createTestTaskState } from './fixtures/createTestTaskState.js'
import type { CTFTaskEvent } from '../src/core/ctfRuntime/taskEvents.js'

describe('Replayer (D)', () => {
  it('replays a minimal event log to summary', () => {
    const initial = createTestTaskState({ taskId: 'rp-1' })
    const events: CTFTaskEvent[] = [
      { type: 'TASK_CREATED', taskId: 'rp-1', initial },
      { type: 'STRATEGY_DECISION_RECORDED', decision: {
        id: 'sd1', taskId: 'rp-1', selectedAction: { type: 'call_tool', toolId: 'file', input: {}, reason: 'r', priority: 1, costTier: 'cheap' } as never,
        rejectedActions: [], reason: 'first', basedOnObservationIds: [], basedOnEvidenceIds: [], basedOnHypothesisIds: [], createdAt: 100,
      } },
      { type: 'ATTEMPT_STARTED', attempt: {
        id: 'att1', taskId: 'rp-1', kind: 'tool', targetId: 'file', input: {}, fingerprint: 'fp1',
        hypothesisIds: [], status: 'running',
        observationIds: [], evidenceIds: [], artifactIds: [], flagCandidateIds: [], createdAt: 100,
      } },
      { type: 'ATTEMPT_COMPLETED', attemptId: 'att1', status: 'succeeded',
        observationIds: ['o1'], evidenceIds: ['e1'], artifactIds: [], flagCandidateIds: [],
        completedAt: 200,
      },
      { type: 'TASK_COMPLETED', status: 'solved', reason: 'done' },
    ]
    const out = replayFromEvents(events)
    expect(out.taskId).toBe('rp-1')
    expect(out.cycles.length).toBeGreaterThan(0)
    expect(out.cycles[0]!.attempts.length).toBe(1)
    expect(out.cycles[0]!.attempts[0]!.status).toBe('succeeded')
    expect(out.stoppedReason).toBe('done')
  })

  it('parses a JSONL string', () => {
    const initial = createTestTaskState({ taskId: 'rp-2' })
    const events: CTFTaskEvent[] = [
      { type: 'TASK_CREATED', taskId: 'rp-2', initial },
    ]
    const jsonl = events.map((e) => JSON.stringify(e)).join('\n')
    const out = replayFromJsonl(jsonl)
    expect(out.taskId).toBe('rp-2')
  })

  it('skips malformed lines in JSONL', () => {
    const out = replayFromJsonl('not-json\n{not-valid}\n')
    // No TASK_CREATED → empty cycles
    expect(out.cycles.length).toBe(0)
  })
})
