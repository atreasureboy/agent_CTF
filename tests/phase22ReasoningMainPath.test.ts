/**
 * Phase 2.3 §二十三 — Real-action main path integration test.
 */

import { describe, it, expect } from 'vitest'
import { CTFTaskStateStore } from '../src/core/ctfRuntime/taskStateStore.js'
import { processNewReasoningInputs } from '../src/core/ctfReasoning/reasoningCoordinator.js'
import type { ActionExecutionResult } from '../src/core/ctfReasoning/actionExecutionResult.js'
import type { SuggestedAction } from '../src/core/ctfReasoning/suggestedAction.js'
import { materializeViaRegistry } from '../src/core/ctfReasoning/parserRegistry.js'
import { createTestTaskState } from './fixtures/createTestTaskState.js'

async function materializePng(toolId: string) {
  return materializeViaRegistry(
    { toolId },
    {
      taskId: 'main-path',
      source: { type: 'tool', toolId },
      content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0]).toString('binary'),
      artifactIds: [],
      isError: false,
    },
  )
}

describe('Phase 2.3 §二十三 — real-action main path', () => {
  it('drive a real tool call through the Coordinator and bind products', async () => {
    const state = createTestTaskState({ taskId: 'main-path' })
    const store = new CTFTaskStateStore(state)

    const executor = {
      async execute({ action }: { action: SuggestedAction }): Promise<ActionExecutionResult> {
        if (action.type === 'call_tool' && action.toolId === 'file') {
          const m = await materializePng('file')
          return { status: 'executed', materializedResult: m, executionRefs: { attemptId: 'att1' } }
        }
        return {
          status: 'executed',
          materializedResult: { observations: [], evidence: [], suggestedActions: [], flagCandidateDrafts: [], warnings: [], rawArtifactIds: [] },
          executionRefs: {},
        }
      },
    }

    const triage = await processNewReasoningInputs({
      taskId: 'main-path',
      state,
      store,
      executor,
      budgetLimits: { fastConcurrency: 4, mediumConcurrency: 2, heavyConcurrency: 1, perTaskMaxRuns: 100, perTaskHeavyRuns: 4 },
      heavyApproved: true,
    }, {
      source: 'main-agent',
      newObservationIds: [],
      newEvidenceIds: [],
      suggestedActions: [
        { type: 'call_tool', toolId: 'file', input: { path: 'unknown.bin' }, reason: 'identify', priority: 5, costTier: 'cheap' },
      ],
    })

    expect(triage.cycles).toBeGreaterThan(0)
    expect(store.getState().observations.length).toBeGreaterThan(0)
    expect(store.getState().evidence.length).toBeGreaterThan(0)
    expect(store.getState().attempts.some((a) => a.observationIds.length > 0)).toBe(true)
    // No Executor fallback used — must have actually invoked the executor.
    expect(store.getState().strategyDecisions.length).toBeGreaterThan(0)
  })
})