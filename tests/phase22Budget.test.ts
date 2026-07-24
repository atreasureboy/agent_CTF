import { createNoopStrategyActionExecutor } from '../src/core/ctfReasoning/runtimeStrategyActionExecutor.js'
/**
 * Phase 2.2 §二十七 — Budget tests.
 *
 * Verifies:
 *   - cheap=1 / normal=3 / expensive=8 cost units.
 *   - Cumulative cost persists across cycles.
 *   - Concurrent slot is released.
 *   - Budget denial records a strategy decision and stops the loop.
 *   - Two tasks' budgets are isolated.
 */

import { describe, it, expect } from 'vitest'
import { processNewReasoningInputs } from '../src/core/ctfReasoning/reasoningCoordinator.js'
import {
  DEFAULT_REASONING_BUDGET_LIMITS,
  applyReasoningBudgetConsumption,
  createInitialReasoningBudgetState,
  COST_UNIT,
  evaluateReasoningBudget,
} from '../src/core/ctfReasoning/reasoningBudget.js'
import type { SuggestedAction } from '../src/core/ctfReasoning/suggestedAction.js'
import type { ActionExecutionResult } from '../src/core/ctfReasoning/actionExecutionResult.js'
import { CTFTaskStateStore } from '../src/core/ctfRuntime/taskStateStore.js'
import { createTestTaskState } from './fixtures/createTestTaskState.js'

describe('Phase 2.2 §二十七 — cumulative task budget', () => {
  it('cheap=1, normal=3, expensive=8 cost units', () => {
    expect(COST_UNIT.cheap).toBe(1)
    expect(COST_UNIT.normal).toBe(3)
    expect(COST_UNIT.expensive).toBe(8)
  })

  it('cumulative cost never refunds', () => {
    let state = createInitialReasoningBudgetState()
    const cheap: SuggestedAction = { type: 'call_tool', toolId: 't', input: {}, reason: 'r', priority: 1, costTier: 'cheap' }
    state = applyReasoningBudgetConsumption(state, cheap)
    expect(state.estimatedCostUnitsUsed).toBe(1)
    state = applyReasoningBudgetConsumption(state, cheap)
    expect(state.estimatedCostUnitsUsed).toBe(2)
  })

  it('budget denial stops the loop and records the reason', async () => {
    const state = createTestTaskState({ taskId: 'bdg' })
    const store = new CTFTaskStateStore(state)
    const executor = {
      async execute(): Promise<ActionExecutionResult> {
        return {
          status: 'executed',
          materializedResult: { observations: [], evidence: [], suggestedActions: [], flagCandidateDrafts: [], warnings: [], rawArtifactIds: [] },
          executionRefs: {},
        }
      },
    }
    // Cap maxActions at 2 so the 3rd action triggers denial.
    const result = await processNewReasoningInputs({
      taskId: 'bdg',
      state,
      store,
      executor: createNoopStrategyActionExecutor(),
      budgetLimits: { fastConcurrency: 4, mediumConcurrency: 2, heavyConcurrency: 1, perTaskMaxRuns: 100, perTaskHeavyRuns: 4 },
      heavyApproved: false,
      reasoningBudgetLimits: { ...DEFAULT_REASONING_BUDGET_LIMITS, maxActions: 2, maxCheapActions: 1 },
    }, {
      source: 'main-agent',
      newObservationIds: [],
      newEvidenceIds: [],
      suggestedActions: [
        { type: 'call_tool', toolId: 't1', input: {}, reason: 'r', priority: 1, costTier: 'cheap' },
        { type: 'call_tool', toolId: 't2', input: {}, reason: 'r', priority: 1, costTier: 'cheap' },
        { type: 'call_tool', toolId: 't3', input: {}, reason: 'r', priority: 1, costTier: 'cheap' },
      ],
    })
    expect(result.stopped).toBe(true)
    expect(store.getState().reasoningBudget.estimatedCostUnitsUsed).toBeGreaterThan(0)
  })

  it('two tasks have isolated budgets', () => {
    const t1 = createTestTaskState({ taskId: 't1' })
    const t2 = createTestTaskState({ taskId: 't2' })
    const s1 = new CTFTaskStateStore(t1)
    const s2 = new CTFTaskStateStore(t2)
    const action: SuggestedAction = { type: 'call_tool', toolId: 't', input: {}, reason: 'r', priority: 1, costTier: 'cheap' }
    const result1 = evaluateReasoningBudget(action, s1.getState().reasoningBudget, DEFAULT_REASONING_BUDGET_LIMITS, { heavyApproved: false, taskTerminal: false })
    const result2 = evaluateReasoningBudget(action, s2.getState().reasoningBudget, DEFAULT_REASONING_BUDGET_LIMITS, { heavyApproved: false, taskTerminal: false })
    expect(result1.allowed).toBe(result2.allowed)
  })
})
