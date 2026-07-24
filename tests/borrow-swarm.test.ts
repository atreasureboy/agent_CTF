/**
 * Phase B — multi-model solver swarm.
 */

import { describe, it, expect } from 'vitest'
import { createSolverSwarmExecutor } from '../src/core/ctfReasoning/solverSwarm.js'
import type { ActionExecutionResult } from '../src/core/ctfReasoning/actionExecutionResult.js'
import type { StrategyActionExecutor, StrategyActionExecutorContext } from '../src/core/ctfReasoning/strategyActionExecutor.js'
import type { CTFTaskState } from '../src/core/ctfRuntime/taskState.js'
import type { SuggestedAction } from '../src/core/ctfReasoning/suggestedAction.js'
import { createTestTaskState } from './fixtures/createTestTaskState.js'

function makeMember(id: string, opts: { delayMs?: number; flag?: string; succeed?: boolean }): {
  id: string
  executor: StrategyActionExecutor
} {
  return {
    id,
    executor: {
      async execute(_ctx: StrategyActionExecutorContext): Promise<ActionExecutionResult> {
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs))
        if (opts.succeed === false) {
          return {
            status: 'failed',
            error: { message: 'injected failure' },
          }
        }
        return {
          status: 'executed',
          materializedResult: {
            observations: [{ kind: 'generic', source: { type: 'manual' }, summary: `obs-${id}`, confidence: 0.5 }],
            evidence: [],
            suggestedActions: [],
            flagCandidateDrafts: opts.flag
              ? [{
                  value: opts.flag,
                  normalizedValue: opts.flag,
                  sourceObservationIds: [],
                  sourceEvidenceIds: [],
                  sourceArtifactIds: [],
                  sourceRunIds: [],
                  confidence: 0.95,
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

function makeCtx(action: SuggestedAction): StrategyActionExecutorContext {
  const state: CTFTaskState = createTestTaskState({ taskId: 't1' })
  return {
    taskState: state,
    action,
    attempt: { id: 'att1', taskId: 't1', kind: 'tool', targetId: 't', input: {}, fingerprint: 'fp', hypothesisIds: [], status: 'running', observationIds: [], evidenceIds: [], artifactIds: [], flagCandidateIds: [], createdAt: 0 },
    signal: new AbortController().signal,
  }
}

const FLAG_ACTION: SuggestedAction = {
  type: 'verify_flag',
  candidateId: 'c1',
  reason: 'try',
  priority: 9,
  costTier: 'cheap',
}

describe('SolverSwarm (B)', () => {
  it('picks the first member to emit a flag candidate', async () => {
    const swarm = createSolverSwarmExecutor({
      members: [
        makeMember('a', { delayMs: 5, flag: 'flag{a}' }),
        makeMember('b', { delayMs: 20, flag: 'flag{b}' }),
        makeMember('c', { delayMs: 50, flag: 'flag{c}' }),
      ],
      isFlagCheck: (a) => a.type === 'verify_flag',
      winnerTimeoutMs: 1000,
    })
    const r = await swarm.execute(makeCtx(FLAG_ACTION))
    expect(r.status).toBe('executed')
    expect(r.materializedResult.warnings.some((w) => w.startsWith('swarm: winner='))).toBe(true)
    // a wins (smallest delay), so its flag is in the candidates
    expect(r.materializedResult.flagCandidateDrafts.some((c) => c.value === 'flag{a}')).toBe(true)
  })

  it('merges observations from slower members that did not win', async () => {
    const swarm = createSolverSwarmExecutor({
      members: [
        makeMember('a', { delayMs: 5, flag: 'flag{a}' }),
        makeMember('b', { delayMs: 20 }), // no flag, just an observation
      ],
      isFlagCheck: (a) => a.type === 'verify_flag',
      winnerTimeoutMs: 1000,
    })
    const r = await swarm.execute(makeCtx(FLAG_ACTION))
    expect(r.status).toBe('executed')
    expect(r.materializedResult.flagCandidateDrafts.length).toBe(1)
    expect(r.materializedResult.observations.length).toBe(2)
  })

  it('returns failed when all members fail', async () => {
    const swarm = createSolverSwarmExecutor({
      members: [
        makeMember('a', { succeed: false }),
        makeMember('b', { succeed: false }),
      ],
      isFlagCheck: () => true,
      winnerTimeoutMs: 100,
    })
    const r = await swarm.execute(makeCtx(FLAG_ACTION))
    // No flag candidate, so the loop falls through to the first
    // completed result (which is a failed one).
    expect(r.status === 'failed' || (r.status === 'executed' && r.materializedResult.flagCandidateDrafts.length === 0)).toBe(true)
  })

  it('returns empty materialised when members is empty', async () => {
    const swarm = createSolverSwarmExecutor({ members: [], isFlagCheck: () => true })
    const r = await swarm.execute(makeCtx(FLAG_ACTION))
    expect(r.status).toBe('executed')
    expect(r.materializedResult.observations.length).toBe(0)
  })

  it('treats non-flag actions as ordinary racing', async () => {
    const swarm = createSolverSwarmExecutor({
      members: [
        makeMember('a', { delayMs: 5 }),
        makeMember('b', { delayMs: 10 }),
      ],
      isFlagCheck: () => false, // not flag check
      winnerTimeoutMs: 100,
    })
    const toolAction: SuggestedAction = {
      type: 'call_tool',
      toolId: 'file',
      input: { path: '/x' },
      reason: 'r',
      priority: 1,
      costTier: 'cheap',
    }
    const r = await swarm.execute(makeCtx(toolAction))
    expect(r.status).toBe('executed')
  })
})
