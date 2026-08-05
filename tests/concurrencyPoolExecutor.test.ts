/**
 * §Round-7 — prove ChallengeConcurrencyPool actually runs the
 * TaskExecutor for each spawned handle, instead of leaving the
 * handle stuck in 'running' forever (the previous Round-3–6 bug).
 *
 * Strategy: register 3 challenges, give the pool an executor that
 * records each call + resolves after a short delay, call
 * spawnNext(), then await waitForAll(). Assert every challenge was
 * dispatched AND that handles transitioned queued → running → done.
 */

import { describe, it, expect } from 'vitest'

import { ChallengeConcurrencyPool } from '../src/core/ctfRuntime/challengeConcurrencyPool.js'
import type {
  QueuedChallenge,
  TaskExecutor,
} from '../src/core/ctfRuntime/challengeConcurrencyPool.js'

describe('ChallengeConcurrencyPool executor wiring', () => {
  it('actually fires the executor for each spawned handle', async () => {
    const pool = new ChallengeConcurrencyPool(3)

    const calls: string[] = []
    const executor: TaskExecutor = async (ch) => {
      calls.push(ch.id)
      // Simulate solver work — sleep, then signal completion.
      await new Promise((r) => setTimeout(r, 50))
      pool.markCompleted(ch.id, 'solved', `flag{${ch.id}}`)
      return { status: 'solved', flag: `flag{${ch.id}}` }
    }
    // Replace the pool's executor via a small wrapper. We can't pass
    // it through the constructor because TS infers the type, so we
    // attach via private property through a cast.
    ;(pool as unknown as { executor: TaskExecutor }).executor = executor

    pool.addChallenges([
      { id: 'ch_a', title: 'A', category: 'crypto', priority: 1 },
      { id: 'ch_b', title: 'B', category: 'web', priority: 2 },
      { id: 'ch_c', title: 'C', category: 'forensics', priority: 3 },
    ])

    expect(pool.getStats().queued).toBe(3)
    expect(pool.getStats().running).toBe(0)

    const spawned = pool.spawnNext()
    expect(spawned.length).toBe(3)
    expect(pool.getStats().running).toBe(3)
    expect(pool.getStats().queued).toBe(0)

    // Wait for all executors to settle (≤3 × 50ms = 150ms).
    await pool.waitForAll()

    // Every challenge was actually dispatched to the executor.
    expect(calls.sort()).toEqual(['ch_a', 'ch_b', 'ch_c'])

    // All handles transitioned to solved.
    expect(pool.getStats().solved).toBe(3)
    expect(pool.getStats().running).toBe(0)
  })

  it('continues spawning after a completion frees a slot', async () => {
    const pool = new ChallengeConcurrencyPool(2)
    const executor: TaskExecutor = async (ch) => {
      await new Promise((r) => setTimeout(r, 20))
      pool.markCompleted(ch.id, 'solved')
      return { status: 'solved' as const }
    }
    ;(pool as unknown as { executor: TaskExecutor }).executor = executor

    pool.addChallenges([
      { id: 'p1', title: '', category: 'crypto' },
      { id: 'p2', title: '', category: 'web' },
      { id: 'p3', title: '', category: 'forensics' },
    ])

    pool.spawnNext() // spawns p1 + p2
    expect(pool.getStats().running).toBe(2)
    await pool.waitForAll()
    // Now slots free and p3 is still queued.
    expect(pool.getStats().solved).toBe(2)
    expect(pool.getStats().queued).toBe(1)

    pool.spawnNext() // picks up p3
    expect(pool.getStats().running).toBe(1)
    await pool.waitForAll()
    expect(pool.getStats().solved).toBe(3)
  })
})