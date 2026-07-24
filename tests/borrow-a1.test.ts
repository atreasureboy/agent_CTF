/**
 * Phase A1 — Trajectory event dump.
 */

import { describe, it, expect } from 'vitest'
import { readFile, mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { CTFTaskStateStore } from '../src/core/ctfRuntime/taskStateStore.js'
import { TaskEventLogger } from '../src/core/ctfRuntime/eventLogger.js'
import { replayFromEventLog } from '../src/core/ctfRuntime/replayer.js'
import { createTestTaskState } from './fixtures/createTestTaskState.js'

describe('TaskEventLogger (A1)', () => {
  it('writes every apply() event to events.ndjson', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ctf-evtlog-'))
    try {
      const state = createTestTaskState({ taskId: 'evt-1' })
      const store = new CTFTaskStateStore(state)
      const log = await TaskEventLogger.attach(store, dir)
      store.apply({ type: 'STRATEGY_DECISION_RECORDED', decision: {
        id: 'sd1', taskId: 'evt-1', selectedAction: { type: 'call_tool', toolId: 'file', input: {}, reason: 'r', priority: 1, costTier: 'cheap' } as never,
        rejectedActions: [], reason: 'first decision', basedOnObservationIds: [], basedOnEvidenceIds: [], basedOnHypothesisIds: [], createdAt: 100,
      } })
      store.apply({ type: 'REASONING_BUDGET_CONSUMED', snapshot: state.reasoningBudget })
      await log.close()
      expect(log.written).toBe(2)
      const content = await readFile(log.path, 'utf-8')
      const lines = content.split('\n').filter((l) => l.length > 0)
      expect(lines.length).toBe(2)
      const parsed = JSON.parse(lines[0]!)
      expect(parsed.type).toBe('STRATEGY_DECISION_RECORDED')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('written log is round-trippable through Replayer', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ctf-evtlog-rt-'))
    try {
      const state = createTestTaskState({ taskId: 'rt-1' })
      const store = new CTFTaskStateStore(state)
      const log = await TaskEventLogger.attach(store, dir)
      store.apply({ type: 'TASK_CREATED', taskId: 'rt-1', initial: state })
      store.apply({ type: 'STRATEGY_DECISION_RECORDED', decision: {
        id: 'sd1', taskId: 'rt-1', selectedAction: { type: 'call_tool', toolId: 'file', input: {}, reason: 'r', priority: 1, costTier: 'cheap' } as never,
        rejectedActions: [], reason: 'first decision', basedOnObservationIds: [], basedOnEvidenceIds: [], basedOnHypothesisIds: [], createdAt: 200,
      } })
      await log.close()
      const out = await replayFromEventLog(log.path)
      expect(out.taskId).toBe('rt-1')
      expect(out.cycles.length).toBeGreaterThan(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
