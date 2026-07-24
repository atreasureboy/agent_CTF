/**
 * Real benchmark runner tests — uses MockLlmProvider to simulate a
 * real LLM emitting structured actions.
 */

import { describe, it, expect } from 'vitest'
import { runLiveChallenge, createLlmToolActionExecutor } from '../src/bench/liveBenchRunner.js'
import { MockLlmProvider, type ToolUseRequest } from '../src/core/llm/llmToolUse.js'
import type { BenchChallenge } from '../src/bench/runner.js'

const challenge: BenchChallenge = {
  id: 'live-1',
  category: 'crypto',
  prompt: 'find the flag',
  expectedFlag: 'flag{live_test_1}',
}

function makeReq(action: Record<string, unknown>): ToolUseRequest {
  return { id: `req-${Math.random().toString(36).slice(2)}`, raw: action }
}

describe('LiveBenchRunner (real D2)', () => {
  it('runs a fake-LLM cycle and wins when the LLM submits the correct flag', async () => {
    let callCount = 0
    const provider = new MockLlmProvider('mock-live-1', null)
    const executor = createLlmToolActionExecutor({ expectedFlag: challenge.expectedFlag })
    const wrappedExecutor: typeof executor = {
      async execute(ctx) {
        callCount += 1
        return executor.execute(ctx)
      },
    }
    // Single response: the right flag. The LLM wins in cycle 0.
    const responses: ToolUseRequest[] = [
      makeReq({
        type: 'call_tool', toolId: 'submit_flag', input: { flag: challenge.expectedFlag },
        reason: 'try the right one', priority: 2, costTier: 'cheap',
      }),
    ]
    let idx = 0
    const cyclingProvider = {
      ...provider,
      async generateToolUse() {
        const r = responses[idx] ?? responses[responses.length - 1]!
        idx += 1
        return r
      },
    }
    const r = await runLiveChallenge(challenge, {
      provider: cyclingProvider,
      executor: wrappedExecutor,
      maxCycles: 4,
    })
    expect(r.won).toBe(true)
    expect(r.submittedFlag).toBe(challenge.expectedFlag)
    expect(r.cycles).toBe(1)
    expect(r.history.length).toBe(1)
    expect(callCount).toBe(1)
  })

  it('aborts gracefully when the LLM emits free-form text', async () => {
    const provider = new MockLlmProvider('mock-live-2', null)
    const r = await runLiveChallenge(challenge, {
      provider,
      maxCycles: 3,
    })
    expect(r.won).toBe(false)
    expect(r.notes.some((n) => n.includes('free text'))).toBe(true)
  })

  it('does not win when the LLM submits the wrong flag', async () => {
    const provider = new MockLlmProvider('mock-live-3', null)
    // Only the wrong flag — never the right one.
    const responses: ToolUseRequest[] = [
      makeReq({
        type: 'call_tool', toolId: 'submit_flag', input: { flag: 'flag{wrong}' },
        reason: 'try', priority: 1, costTier: 'cheap',
      }),
    ]
    let idx = 0
    const cyclingProvider = {
      ...provider,
      async generateToolUse() {
        return responses[idx++] ?? responses[responses.length - 1]!
      },
    }
    const r = await runLiveChallenge(challenge, {
      provider: cyclingProvider,
      maxCycles: 3,
    })
    expect(r.won).toBe(false)
    // The losing outcome shows up as no winning flag candidate in
    // any of the cycles. History entries are `ok: true` whenever
    // the LLM emitted a valid action (the executor's wrong-flag
    // check is a separate warning that doesn't surface in the
    // live-bench notes).
    expect(r.cycles).toBeGreaterThanOrEqual(1)
    expect(r.history.length).toBeGreaterThanOrEqual(1)
  })
})
