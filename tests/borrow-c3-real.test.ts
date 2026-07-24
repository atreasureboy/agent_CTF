/**
 * Phase C3-real — LMSummarizer in the live loop.
 */

import { describe, it, expect } from 'vitest'
import { processNewReasoningInputs } from '../src/core/ctfReasoning/reasoningCoordinator.js'
import { CTFTaskStateStore } from '../src/core/ctfRuntime/taskStateStore.js'
import { createNoopStrategyActionExecutor } from '../src/core/ctfReasoning/runtimeStrategyActionExecutor.js'
import { NoOpLMSummarizer, LMSummarizer, type LanguageModel } from '../src/core/ctfReasoning/lmSummarizer.js'
import { createObservation } from '../src/core/ctfReasoning/observation.js'
import { createTestTaskState } from './fixtures/createTestTaskState.js'
import { createLlmToolActionExecutor } from '../src/bench/liveBenchRunner.js'

function stateWithManyObs(taskId: string, n: number) {
  let cur = createTestTaskState({ taskId })
  for (let i = 0; i < n; i++) {
    const obs = createObservation(taskId, {
      kind: 'generic', source: { type: 'manual' },
      summary: `obs ${i}`, confidence: 0.5,
    })
    cur = { ...cur, observations: [...cur.observations, obs] }
  }
  return cur
}

describe('LMSummarizer in the live loop (C3-real)', () => {
  it('runs the summarizer when observations exceed threshold', async () => {
    const initial = stateWithManyObs('c3r-1', 80)
    const store = new CTFTaskStateStore(initial)
    const mockLM: LanguageModel = {
      async generate(_p: string): Promise<string> {
        return 'live summary text'
      },
    }
    const summary = new LMSummarizer(mockLM)
    const result = await processNewReasoningInputs(
      {
        taskId: 'c3r-1',
        state: initial,
        store,
        budgetLimits: { fastConcurrency: 1, mediumConcurrency: 1, heavyConcurrency: 1, perTaskMaxRuns: 4, perTaskHeavyRuns: 1 },
        heavyApproved: false,
        executor: createNoopStrategyActionExecutor(),
        maxStrategyCycles: 1,
      },
      {
        source: 'main-agent',
        newObservationIds: [],
        newEvidenceIds: [],
        suggestedActions: [
          { type: 'verify_flag', candidateId: 'c1', reason: 'try', priority: 1, costTier: 'cheap' },
        ],
        lmSummarizer: summary,
        compactionThreshold: 64,
      },
    )
    expect(result.cycles).toBeGreaterThan(0)
    // The summary should be recorded in diagnostics.
    const lastDiag = store.getState().diagnostics.at(-1)
    expect(lastDiag?.message).toContain('lm-summary')
  })

  it('does not run when observations are below threshold', async () => {
    const initial = stateWithManyObs('c3r-2', 10)
    const store = new CTFTaskStateStore(initial)
    const calls: string[] = []
    const mockLM: LanguageModel = {
      async generate(p: string): Promise<string> {
        calls.push(p)
        return 'unwanted summary'
      },
    }
    const summary = new LMSummarizer(mockLM)
    await processNewReasoningInputs(
      {
        taskId: 'c3r-2',
        state: initial,
        store,
        budgetLimits: { fastConcurrency: 1, mediumConcurrency: 1, heavyConcurrency: 1, perTaskMaxRuns: 4, perTaskHeavyRuns: 1 },
        heavyApproved: false,
        executor: createNoopStrategyActionExecutor(),
        maxStrategyCycles: 1,
      },
      {
        source: 'main-agent',
        newObservationIds: [],
        newEvidenceIds: [],
        suggestedActions: [],
        lmSummarizer: summary,
        compactionThreshold: 64,
      },
    )
    expect(calls.length).toBe(0)
  })

  it('tolerates an LMSummarizer that throws', async () => {
    const initial = stateWithManyObs('c3r-3', 80)
    const store = new CTFTaskStateStore(initial)
    const failingLM: LanguageModel = {
      async generate(): Promise<string> {
        throw new Error('LLM offline')
      },
    }
    const summary = new LMSummarizer(failingLM)
    await expect(processNewReasoningInputs(
      {
        taskId: 'c3r-3',
        state: initial,
        store,
        budgetLimits: { fastConcurrency: 1, mediumConcurrency: 1, heavyConcurrency: 1, perTaskMaxRuns: 4, perTaskHeavyRuns: 1 },
        heavyApproved: false,
        executor: createNoopStrategyActionExecutor(),
        maxStrategyCycles: 1,
      },
      {
        source: 'main-agent',
        newObservationIds: [],
        newEvidenceIds: [],
        suggestedActions: [],
        lmSummarizer: summary,
        compactionThreshold: 64,
      },
    )).resolves.toBeDefined()
  })

  it('NoOpLMSummarizer is a safe default in tests', async () => {
    const initial = stateWithManyObs('c3r-4', 80)
    const store = new CTFTaskStateStore(initial)
    const summary = new LMSummarizer(new NoOpLMSummarizer())
    const r = await processNewReasoningInputs(
      {
        taskId: 'c3r-4',
        state: initial,
        store,
        budgetLimits: { fastConcurrency: 1, mediumConcurrency: 1, heavyConcurrency: 1, perTaskMaxRuns: 4, perTaskHeavyRuns: 1 },
        heavyApproved: false,
        executor: createNoopStrategyActionExecutor(),
        maxStrategyCycles: 1,
      },
      {
        source: 'main-agent',
        newObservationIds: [],
        newEvidenceIds: [],
        suggestedActions: [],
        lmSummarizer: summary,
        compactionThreshold: 64,
      },
    )
    expect(r.cycles).toBeGreaterThan(0)
  })
})
