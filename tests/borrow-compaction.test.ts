/**
 * Phase G — context compaction.
 */

import { describe, it, expect } from 'vitest'
import { decideCompaction, applyCompaction, DEFAULT_COMPACTION_POLICY } from '../src/core/ctfReasoning/contextCompactor.js'
import { createTestTaskState } from './fixtures/createTestTaskState.js'
import { createObservation } from '../src/core/ctfReasoning/observation.js'

function makeStateWithObs(n: number, kind: string = 'generic') {
  const state = createTestTaskState({ taskId: 'c1' })
  let cur = state
  for (let i = 0; i < n; i++) {
    const obs = createObservation('c1', {
      kind: kind as 'generic', source: { type: 'manual' }, summary: `obs ${i}`, confidence: 0.5,
    })
    cur = { ...cur, observations: [...cur.observations, obs] }
  }
  return cur
}

describe('ContextCompactor (G)', () => {
  it('does not compact when under policy', () => {
    const state = makeStateWithObs(10)
    const d = decideCompaction(state)
    expect(d.shouldCompact).toBe(false)
  })

  it('compacts when over observation policy', () => {
    const state = makeStateWithObs(80)
    const d = decideCompaction(state)
    expect(d.shouldCompact).toBe(true)
    expect(d.keptObservations).toBe(DEFAULT_COMPACTION_POLICY.maxObservations)
    expect(d.removedObservationIds.length).toBe(80 - DEFAULT_COMPACTION_POLICY.maxObservations)
  })

  it('applyCompaction returns a state with the older items removed and a summary observation', () => {
    const state = makeStateWithObs(80)
    const d = decideCompaction(state)
    const after = applyCompaction(state, d, 1234)
    expect(after.observations.length).toBe(DEFAULT_COMPACTION_POLICY.maxObservations + 1)
    // The +1 is the summary observation.
    const summary = after.observations[after.observations.length - 1]!
    expect(summary.summary).toContain('compaction token')
    expect(summary.id).toContain('obs_compact_')
    expect(after.findings.length).toBe(0) // no findings were compacted
  })

  it('does not compact evidence when under policy', () => {
    const state = createTestTaskState({ taskId: 'c2' })
    const d = decideCompaction(state, { ...DEFAULT_COMPACTION_POLICY, maxObservations: 1 })
    // maxObservations=1 with 0 observations — shouldCompact stays false.
    expect(d.shouldCompact).toBe(false)
  })
})
