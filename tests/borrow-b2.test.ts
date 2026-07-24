/**
 * Phase B2 — ApproachContest (CAI pattern).
 */

import { describe, it, expect } from 'vitest'
import { createApproachContestExecutor, type ApproachContestFraming } from '../src/core/ctfReasoning/approachContest.js'
import type { ActionExecutionResult } from '../src/core/ctfReasoning/actionExecutionResult.js'
import type { StrategyActionExecutor, StrategyActionExecutorContext } from '../src/core/ctfReasoning/strategyActionExecutor.js'
import type { SuggestedAction } from '../src/core/ctfReasoning/suggestedAction.js'

const flagAction: SuggestedAction = {
  type: 'verify_flag',
  candidateId: 'c1',
  reason: 'try',
  priority: 9,
  costTier: 'cheap',
}

function makeFramer(id: string, prompt: string, delayMs: number, flag?: string): {
  id: string
  prompt: string
  executor: StrategyActionExecutor
} {
  return {
    id,
    prompt,
    executor: {
      async execute(_ctx: StrategyActionExecutorContext): Promise<ActionExecutionResult> {
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs))
        return {
          status: 'executed',
          materializedResult: {
            observations: [],
            evidence: [],
            suggestedActions: [],
            flagCandidateDrafts: flag
              ? [{
                  value: flag,
                  normalizedValue: flag.toLowerCase().trim(),
                  sourceObservationIds: [],
                  sourceEvidenceIds: [],
                  sourceArtifactIds: [],
                  sourceRunIds: [],
                  confidence: 0.99,
                  producer: { type: 'parser', id },
                }]
              : [],
            warnings: [],
            rawArtifactIds: [],
          },
          executionRefs: { attemptId: 'att1' },
        }
      },
    },
  }
}

function makeCtx(): StrategyActionExecutorContext {
  return {
    taskState: { taskId: 't1' } as StrategyActionExecutorContext['taskState'],
    action: flagAction,
    attempt: { id: 'att1' } as StrategyActionExecutorContext['attempt'],
    signal: new AbortController().signal,
  }
}

describe('ApproachContest (B2)', () => {
  it('picks the first framing to emit a flag candidate', async () => {
    const contest = createApproachContestExecutor({
      executor: makeFramer('aggressive', 'be aggressive', 5, 'flag{aggressive}').executor,
      framings: [
        makeFramer('aggressive', 'be aggressive', 5, 'flag{aggressive}'),
        makeFramer('defensive', 'be defensive', 20, 'flag{defensive}'),
      ],
      flagOnly: true,
      winnerTimeoutMs: 1000,
    })
    const r = await contest.execute(makeCtx())
    expect(r.status).toBe('executed')
    if (r.status === 'executed') {
      expect(r.materializedResult.flagCandidateDrafts.some((c) => c.value === 'flag{aggressive}')).toBe(true)
      expect(r.materializedResult.warnings.some((w) => w.startsWith('approach-contest: winner='))).toBe(true)
    }
  })

  it('falls through to first-completed when no framing emits a flag', async () => {
    const contest = createApproachContestExecutor({
      executor: makeFramer('a', 'p', 5).executor,
      framings: [
        makeFramer('a', 'p', 5),
        makeFramer('b', 'p', 20),
      ],
      flagOnly: false,
      winnerTimeoutMs: 1000,
    })
    const r = await contest.execute(makeCtx())
    expect(r.status).toBe('executed')
  })

  it('with a single framing, behaves like the underlying executor', async () => {
    const contest = createApproachContestExecutor({
      executor: makeFramer('a', 'p', 5, 'flag{a}').executor,
      framings: [makeFramer('a', 'p', 5, 'flag{a}')],
      flagOnly: true,
    })
    const r = await contest.execute(makeCtx())
    expect(r.status).toBe('executed')
  })

  it('with no framings, behaves like the underlying executor', async () => {
    const contest = createApproachContestExecutor({
      executor: makeFramer('a', 'p', 5, 'flag{a}').executor,
      framings: [],
      flagOnly: true,
    })
    const r = await contest.execute(makeCtx())
    expect(r.status).toBe('executed')
  })
})
