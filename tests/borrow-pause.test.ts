/**
 * Phase H — HITL pause / resume.
 */

import { describe, it, expect } from 'vitest'
import { CTFTaskStateStore } from '../src/core/ctfRuntime/taskStateStore.js'
import { createTestTaskState } from './fixtures/createTestTaskState.js'

describe('HITL pause (H)', () => {
  it('TASK_PAUSED records a diagnostic but does not change state', () => {
    const initial = createTestTaskState({ taskId: 'p1' })
    const store = new CTFTaskStateStore(initial)
    const before = store.getState()
    store.apply({ type: 'TASK_PAUSED', pausedBy: 'user', reason: 'reviewer requested', at: 1234 })
    const after = store.getState()
    expect(after.phase).toBe(before.phase)
    expect(after.completion).toBe(before.completion)
    expect(after.diagnostics.at(-1)?.message).toBe('paused: reviewer requested')
    expect(after.diagnostics.at(-1)?.at).toBe(1234)
  })

  it('TASK_RESUMED records a diagnostic', () => {
    const initial = createTestTaskState({ taskId: 'p2' })
    const store = new CTFTaskStateStore(initial)
    store.apply({ type: 'TASK_PAUSED', pausedBy: 'user', reason: 'check', at: 1 })
    store.apply({ type: 'TASK_RESUMED', resumedBy: 'user', reason: 'go', at: 2 })
    const after = store.getState()
    expect(after.diagnostics.length).toBe(2)
    expect(after.diagnostics[0]?.message).toContain('paused')
    expect(after.diagnostics[1]?.message).toContain('resumed')
  })

  it('TASK_PAUSED is allowed after TASK_COMPLETED (bookkeeping-only)', () => {
    const initial = createTestTaskState({ taskId: 'p3' })
    const store = new CTFTaskStateStore(initial)
    store.apply({ type: 'TASK_COMPLETED', status: 'failed', reason: 'done' })
    expect(() => store.apply({ type: 'TASK_PAUSED', pausedBy: 'system', reason: 'audit', at: 99 })).not.toThrow()
  })
})
