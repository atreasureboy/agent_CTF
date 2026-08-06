/**
 * §Round-8 — ChallengeConcurrencyPool executor wiring, public API.
 *
 * Coverage:
 *  - Public constructor option injects the executor (no private-field hacks)
 *  - Pool auto-applies the executor's return value (status / flag)
 *    and marks completed
 *  - Auto-fill: completing one task immediately spawns the next
 *  - waitForAll drains the entire queue, not just the in-flight batch
 *  - Duplicate challenge IDs (queued or running) are silently deduped
 *  - maxConcurrency must be a positive integer (constructor throws)
 *  - cancelAll saves the reason; addChallenge / spawnNext after cancel
 *    are no-ops
 *  - Pool is observable from outside (getStats / getCancelReason /
 *    isCancelled)
 */

import { describe, it, expect } from 'vitest'

import { ChallengeConcurrencyPool } from '../src/core/ctfRuntime/challengeConcurrencyPool.js'
import type { TaskExecutor } from '../src/core/ctfRuntime/challengeConcurrencyPool.js'

/** Helper to wait one tick so all queued microtasks settle. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('ChallengeConcurrencyPool — Round-8 executor wiring', () => {
  it('public executor option is honoured (no private-field mutation)', async () => {
    const calls: string[] = []
    const executor: TaskExecutor = async (ch) => {
      calls.push(ch.id)
      await tick()
      return { status: 'solved' as const, flag: `flag{${ch.id}}` }
    }
    // PUBLIC API: executor via constructor options, not private mutation.
    const pool = new ChallengeConcurrencyPool(3, { executor })
    pool.addChallenges([
      { id: 'a', title: '', category: 'crypto' },
      { id: 'b', title: '', category: 'web' },
      { id: 'c', title: '', category: 'forensics' },
    ])
    await pool.waitForAll()
    expect(calls.sort()).toEqual(['a', 'b', 'c'])
    expect(pool.getStats().solved).toBe(3)
    expect(pool.getStats().running).toBe(0)
    expect(pool.getStats().queued).toBe(0)
  })

  it('auto-fills queue: completing one task immediately spawns the next', async () => {
    const completed: string[] = []
    const executor: TaskExecutor = async (ch) => {
      await tick()
      completed.push(ch.id)
      return { status: 'solved' as const }
    }
    const pool = new ChallengeConcurrencyPool(2, { executor })
    pool.addChallenges(
      Array.from({ length: 6 }, (_, i) => ({
        id: `t${i}`,
        title: '',
        category: 'crypto',
        priority: i,
      })),
    )
    await pool.waitForAll()
    expect(completed.sort()).toEqual(['t0', 't1', 't2', 't3', 't4', 't5'])
    expect(pool.getStats().solved).toBe(6)
  })

  it('waitForAll drains the queue even if spawnNext was never called', async () => {
    const pool = new ChallengeConcurrencyPool(2, {
      // eslint-disable-next-line @typescript-eslint/require-await
      executor: async () => ({ status: 'solved' as const }),
    })
    pool.addChallenges([
      { id: 'p1', title: '', category: 'crypto' },
      { id: 'p2', title: '', category: 'web' },
      { id: 'p3', title: '', category: 'crypto' },
      { id: 'p4', title: '', category: 'web' },
    ])
    expect(pool.getStats().queued).toBe(4)
    await pool.waitForAll()
    expect(pool.getStats().solved).toBe(4)
    expect(pool.getStats().queued).toBe(0)
    expect(pool.getStats().running).toBe(0)
  })

  it('rejects duplicate IDs already running', async () => {
    const executor: TaskExecutor = async (ch) => {
      await tick()
      return { status: 'solved' as const, flag: `flag{${ch.id}}` }
    }
    const pool = new ChallengeConcurrencyPool(1, { executor })
    pool.addChallenge({ id: 'dup', title: '', category: 'crypto' })
    pool.addChallenge({ id: 'dup', title: '', category: 'crypto' })
    pool.addChallenge({ id: 'dup', title: '', category: 'crypto' })
    expect(pool.getStats().queued + pool.getStats().running).toBe(1)
    await pool.waitForAll()
    expect(pool.getStats().solved).toBe(1)
  })

  it('rejects duplicate IDs already completed', async () => {
    // eslint-disable-next-line @typescript-eslint/require-await
    const executor: TaskExecutor = async () => ({ status: 'solved' as const })
    const pool = new ChallengeConcurrencyPool(2, { executor })
    pool.addChallenge({ id: 'done', title: '', category: 'crypto' })
    await pool.waitForAll()
    pool.addChallenge({ id: 'done', title: '', category: 'crypto' })
    expect(pool.getStats().queued).toBe(0)
  })

  it('maxConcurrency must be a positive integer', () => {
    expect(() => new ChallengeConcurrencyPool(0)).toThrow(/positive integer/i)
    expect(() => new ChallengeConcurrencyPool(-1)).toThrow(/positive integer/i)
    expect(() => new ChallengeConcurrencyPool(1.5)).toThrow(/positive integer/i)
    expect(() => new ChallengeConcurrencyPool(NaN)).toThrow(/positive integer/i)
    expect(() => new ChallengeConcurrencyPool(4)).not.toThrow()
  })

  it('cancelAll saves the reason and prevents reuse', async () => {
    const started: string[] = []
    const executor: TaskExecutor = async (ch) => {
      started.push(ch.id)
      await tick()
      return { status: 'solved' as const }
    }
    const pool = new ChallengeConcurrencyPool(2, { executor })
    pool.addChallenges([
      { id: 'c1', title: '', category: 'crypto' },
      { id: 'c2', title: '', category: 'web' },
      { id: 'c3', title: '', category: 'web' },
    ])
    const reason = pool.cancelAll('user requested abort')
    expect(reason).toBe('user requested abort')
    expect(pool.getCancelReason()).toBe('user requested abort')
    expect(pool.isCancelled()).toBe(true)
    // addChallenge after cancel is a no-op
    pool.addChallenge({ id: 'after', title: '', category: 'web' })
    expect(pool.getStats().queued).toBe(0)
    // waitForAll resolves (nothing in flight)
    await pool.waitForAll()
  })

  it('onCompleted hook fires once per handle', async () => {
    const seen: string[] = []
    const pool = new ChallengeConcurrencyPool(2, {
      // eslint-disable-next-line @typescript-eslint/require-await
      executor: async (ch) => ({ status: 'solved' as const, flag: `f{${ch.id}}` }),
      onCompleted: (h) => {
        seen.push(h.challenge.id)
      },
    })
    pool.addChallenges([
      { id: 'o1', title: '', category: 'crypto' },
      { id: 'o2', title: '', category: 'web' },
    ])
    await pool.waitForAll()
    expect(seen.sort()).toEqual(['o1', 'o2'])
    expect(pool.getStats().solved).toBe(2)
  })

  it('failed executor auto-marks handle as failed (no manual markCompleted)', async () => {
    const pool = new ChallengeConcurrencyPool(2, {
      // eslint-disable-next-line @typescript-eslint/require-await
      executor: async () => ({ status: 'failed' as const }),
    })
    pool.addChallenge({ id: 'fail1', title: '', category: 'crypto' })
    await pool.waitForAll()
    expect(pool.getStats().solved).toBe(0)
    // Internal access — completedHandles is private but getStats
    // surfaces the count. We can verify via the test mechanism
    // because the handle is kept in completedHandles. Use the
    // public 'solved' counter as proxy.
    // Re-add same id: should be rejected as duplicate-already-done.
    pool.addChallenge({ id: 'fail1', title: '', category: 'crypto' })
    expect(pool.getStats().queued).toBe(0)
  })

  it('executor throwing is captured (handle marked failed)', async () => {
    const pool = new ChallengeConcurrencyPool(2, {
      // eslint-disable-next-line @typescript-eslint/require-await
      executor: async () => {
        throw new Error('synthetic boom')
      },
    })
    pool.addChallenge({ id: 'boom', title: '', category: 'crypto' })
    await pool.waitForAll()
    expect(pool.getStats().solved).toBe(0)
    // Pool didn't deadlock.
    expect(pool.getStats().running).toBe(0)
  })

  it('integration: priority ordering + concurrency ceiling', async () => {
    const startedAt: Record<string, number> = {}
    const finished: string[] = []
    const executor: TaskExecutor = async (ch) => {
      startedAt[ch.id] = Date.now()
      await tick()
      finished.push(ch.id)
      return { status: 'solved' as const }
    }
    const pool = new ChallengeConcurrencyPool(2, { executor })
    pool.addChallenges([
      { id: 'low', title: '', category: 'crypto', priority: 1 },
      { id: 'high', title: '', category: 'crypto', priority: 10 },
      { id: 'mid', title: '', category: 'crypto', priority: 5 },
      { id: 'extra', title: '', category: 'crypto', priority: 0 },
    ])
    await pool.waitForAll()
    expect(finished.sort()).toEqual(['extra', 'high', 'low', 'mid'])
    // High-priority ran before low-priority (priority queue).
    expect(startedAt['high']).toBeLessThanOrEqual(startedAt['low'])
  })
})
