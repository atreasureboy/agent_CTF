import { describe, it, expect } from 'vitest'
import { BudgetManager, BudgetExceededError } from '../../src/ctf/oneshot/index.js'

describe('BudgetManager', () => {
  it('acquires and releases fast lanes up to the limit', () => {
    const bm = new BudgetManager({ fastConcurrency: 2 })
    const a = bm.tryAcquire('task', 'fast')
    const b = bm.tryAcquire('task', 'fast')
    const c = bm.tryAcquire('task', 'fast')
    expect(a).toBeTruthy()
    expect(b).toBeTruthy()
    expect(c).toBeNull()

    if (a) bm.release(a)
    const d = bm.tryAcquire('task', 'fast')
    expect(d).toBeTruthy()
  })

  it('respects per-task max runs', () => {
    const bm = new BudgetManager({ fastConcurrency: 100, perTaskMaxRuns: 2 })
    expect(bm.tryAcquire('task', 'fast')).toBeTruthy()
    expect(bm.tryAcquire('task', 'fast')).toBeTruthy()
    expect(bm.tryAcquire('task', 'fast')).toBeNull()
  })

  it('caps heavy lanes via perTaskHeavyRuns', () => {
    const bm = new BudgetManager({
      fastConcurrency: 100,
      heavyConcurrency: 1,
      perTaskHeavyRuns: 1,
      perTaskMaxRuns: 10,
    })
    expect(bm.tryAcquire('task', 'heavy')).toBeTruthy()
    expect(bm.tryAcquire('task', 'heavy')).toBeNull()
  })

  it('tracks active counts per lane', () => {
    const bm = new BudgetManager()
    const a = bm.tryAcquire('task1', 'fast')
    const b = bm.tryAcquire('task2', 'medium')
    expect(bm.activeCounts()).toEqual({ fast: 1, medium: 1, heavy: 0 })
    if (a) bm.release(a)
    if (b) bm.release(b)
    expect(bm.activeCounts()).toEqual({ fast: 0, medium: 0, heavy: 0 })
  })

  it('updates limits at runtime', () => {
    const bm = new BudgetManager({ fastConcurrency: 1 })
    expect(bm.tryAcquire('t', 'fast')).toBeTruthy()
    expect(bm.tryAcquire('t', 'fast')).toBeNull()
    bm.updateLimits({ fastConcurrency: 5 })
    expect(bm.tryAcquire('t', 'fast')).toBeTruthy()
  })
})
