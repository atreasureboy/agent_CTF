import { describe, it, expect, vi } from 'vitest'
import { ChallengeConcurrencyPool } from '../src/core/ctfRuntime/challengeConcurrencyPool.js'
import { DualSubmissionEngine } from '../src/core/solverPortfolio/dualSubmissionEngine.js'

describe('Competition-Winning Architecture Components', () => {
  describe('ChallengeConcurrencyPool (Multi-Task Concurrency Manager)', () => {
    it('manages challenge queue, priority sorting, and concurrency limits', () => {
      const pool = new ChallengeConcurrencyPool(2) // max 2 active

      pool.addChallenges([
        { id: 'ch_low', title: 'Low Priority', category: 'misc', priority: 1 },
        { id: 'ch_high', title: 'High Priority', category: 'crypto', priority: 10 },
        { id: 'ch_medium', title: 'Medium Priority', category: 'web', priority: 5 },
      ])

      expect(pool.getStats().queued).toBe(3)

      const spawned = pool.spawnNext()
      expect(spawned.length).toBe(2)
      // High priority should be spawned first
      expect(spawned[0].challenge.id).toBe('ch_high')
      expect(spawned[1].challenge.id).toBe('ch_medium')

      expect(pool.getStats().running).toBe(2)
      expect(pool.getStats().queued).toBe(1)

      // Complete one challenge
      pool.markCompleted('ch_high', 'solved', 'flag{high_solved}')
      expect(pool.getStats().solved).toBe(1)
      expect(pool.getAvailableSlots()).toBe(1)

      // Spawn next
      const spawned2 = pool.spawnNext()
      expect(spawned2.length).toBe(1)
      expect(spawned2[0].challenge.id).toBe('ch_low')
    })
  })

  describe('DualSubmissionEngine (Auto vs Manual Submission Protocols)', () => {
    it('queues flag candidate in manual mode and formats markdown report', async () => {
      const engine = new DualSubmissionEngine('manual')

      const res = await engine.processCandidate({
        taskId: 'ch_web_1',
        solverId: 'web_agent',
        candidateValue: 'flag{sql_injection_master}',
        modelId: 'gpt-4o',
      })

      expect(res.status).toBe('simulated_accepted')
      expect(res.message).toContain('[ManualMode Queue]')

      const queue = engine.getManualQueue()
      expect(queue.length).toBe(1)
      expect(queue[0].candidateValue).toBe('flag{sql_injection_master}')

      const report = engine.exportManualReport()
      expect(report).toContain('### 🚩 [CONFIRMED FLAG CANDIDATE]')
      expect(report).toContain('flag{sql_injection_master}')
    })

    it('submits flag automatically via CTFd adapter in auto mode', async () => {
      const engine = new DualSubmissionEngine('auto', {
        baseUrl: 'https://competition.ctf.org',
        apiToken: 'comp_token',
        challengeId: 101,
      })

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ data: { status: 'correct', message: 'Flag accepted!' } }),
        }),
      )

      const res = await engine.processCandidate({
        taskId: 'ch_crypto_1',
        solverId: 'crypto_agent',
        candidateValue: 'flag{rsa_factor_success}',
        modelId: 'gpt-4o',
      })

      expect(res.status).toBe('accepted')
      expect(res.accepted).toBe(true)

      vi.unstubAllGlobals()
    })
  })
})
