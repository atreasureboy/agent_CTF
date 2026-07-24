/**
 * Phase 2.2 §十八 — TaskState immutability tests.
 *
 * Verifies that:
 *   - getState() returns a DeepReadonly state.
 *   - attempts to push/splice mutate it throw.
 *   - apply() returns a new state with fresh array identities.
 *   - reducers do not mutate the previous state.
 */

import { describe, it, expect } from 'vitest'
import { CTFTaskStateStore, TaskStateStoreError } from '../src/core/ctfRuntime/taskStateStore.js'
import { createTestTaskState } from './fixtures/createTestTaskState.js'
import { createObservation } from '../src/core/ctfReasoning/observation.js'

describe('Phase 2.2 §十八 — TaskState immutability', () => {
  it('getState() returns a deeply frozen state — push throws', () => {
    const state = createTestTaskState({ taskId: 'imm-1' })
    const store = new CTFTaskStateStore(state)
    const s = store.getState()
    expect(() => {
      ;(s.observations as unknown as { push: (o: unknown) => void }).push({ id: 'x' })
    }).toThrow()
    expect(() => {
      ;(s.attempts as unknown as { push: (o: unknown) => void }).push({ id: 'x' })
    }).toThrow()
    expect(() => {
      ;(s.evidence as unknown as { push: (o: unknown) => void }).push({ id: 'x' })
    }).toThrow()
    expect(() => {
      ;(s.flagCandidates as unknown as { push: (o: unknown) => void }).push({ id: 'x' })
    }).toThrow()
  })

  it('apply() returns a new state with fresh array identities', () => {
    const state = createTestTaskState({ taskId: 'imm-2' })
    const store = new CTFTaskStateStore(state)
    const before = store.getState()
    const obs = createObservation('imm-2', {
      kind: 'command_status',
      source: { type: 'manual' },
      summary: 'test',
      confidence: 0.5,
    })
    store.apply({ type: 'OBSERVATION_ADDED', observation: obs })
    const after = store.getState()
    expect(before).not.toBe(after)
    expect(before.observations).not.toBe(after.observations)
    expect(after.observations.length).toBe(1)
  })

  it('reducer does not mutate the previous state', () => {
    const state = createTestTaskState({ taskId: 'imm-3' })
    const store = new CTFTaskStateStore(state)
    const obs = createObservation('imm-3', {
      kind: 'command_status',
      source: { type: 'manual' },
      summary: 'test',
      confidence: 0.5,
    })
    store.apply({ type: 'OBSERVATION_ADDED', observation: obs })
    const before = store.getState()
    const obs2 = createObservation('imm-3', {
      kind: 'command_status',
      source: { type: 'manual' },
      summary: 'test 2',
      confidence: 0.6,
    })
    store.apply({ type: 'OBSERVATION_ADDED', observation: obs2 })
    const after = store.getState()
    expect(before.observations.length).toBe(1)
    expect(after.observations.length).toBe(2)
  })

  it('deep freeze does not break AbortSignal', () => {
    const state = createTestTaskState({ taskId: 'imm-4' })
    const store = new CTFTaskStateStore(state)
    // The context's abortSignal survives deepFreeze and can still be aborted.
    const s = store.getState()
    expect(s.context.abortSignal?.aborted).toBe(false)
  })

  it('duplicate ID throws on apply', () => {
    const state = createTestTaskState({ taskId: 'imm-5' })
    const store = new CTFTaskStateStore(state)
    const obs = createObservation('imm-5', {
      kind: 'command_status',
      source: { type: 'manual' },
      summary: 'test',
      confidence: 0.5,
    })
    store.apply({ type: 'OBSERVATION_ADDED', observation: obs })
    expect(() => store.apply({ type: 'OBSERVATION_ADDED', observation: obs }))
      .toThrow(TaskStateStoreError)
  })
})