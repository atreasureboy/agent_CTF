/**
 * Phase E — benchmark harness smoke test.
 */

import { describe, it, expect } from 'vitest'
import {
  runChallenge,
  runBenchSuite,
  createFixtureExecutor,
  buildStateForChallenge,
  type BenchChallenge,
} from '../src/bench/runner.js'
import { tmpdir } from 'os'
import { join } from 'path'

const fixture: BenchChallenge[] = [
  {
    id: 'basic-1',
    category: 'crypto',
    prompt: 'A simple warm-up: the flag is flag{test_basic_1}.',
    expectedFlag: 'flag{test_basic_1}',
  },
  {
    id: 'basic-2',
    category: 'web',
    prompt: 'A second fixture: the flag is flag{test_basic_2}.',
    expectedFlag: 'flag{test_basic_2}',
  },
  {
    id: 'loser-1',
    category: 'reverse',
    prompt: 'A hard one (no fixture solver).',
    expectedFlag: 'flag{hint_not_provided}',
  },
]

describe('BenchRunner (E)', () => {
  it('buildStateForChallenge produces a usable initial state', () => {
    const s = buildStateForChallenge(fixture[0]!, 't1')
    expect(s.taskId).toBe('t1')
    expect(s.observations.length).toBe(0)
    // A flag candidate is pre-seeded so the verify_flag action finds it.
    expect(s.flagCandidates.length).toBe(1)
    expect(s.flagCandidates[0]!.value).toBe('flag{test_basic_1}')
  })

  it('runChallenge wins a fixture with the correct flag', async () => {
    const executor = createFixtureExecutor({ expectedFlag: 'flag{test_basic_1}' })
    const r = await runChallenge(fixture[0]!, {
      executor,
      budgetLimits: { fastConcurrency: 1, mediumConcurrency: 1, heavyConcurrency: 1, perTaskMaxRuns: 4, perTaskHeavyRuns: 1 },
    })
    expect(r.won).toBe(true)
    expect(r.submittedFlag).toBe('flag{test_basic_1}')
  })

  it('runBenchSuite aggregates per category', async () => {
    const dir = join(tmpdir(), 'agent_CTF-bench-' + Date.now())
    const executor = createFixtureExecutor({ expectedFlag: 'flag{test_basic_1}' })
    const { results, summaryPath } = await runBenchSuite('smoke', [fixture[0]!, fixture[1]!], {
      executor,
      budgetLimits: { fastConcurrency: 1, mediumConcurrency: 1, heavyConcurrency: 1, perTaskMaxRuns: 4, perTaskHeavyRuns: 1 },
      outDir: dir,
    })
    expect(results.length).toBe(2)
    // The third fixture has the wrong expected flag so it would be a
    // loser; we only ran the first two here.
    expect(summaryPath).toMatch(/summary\.json$/)
  }, 30_000)
})
