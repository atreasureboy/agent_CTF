/**
 * Phase C3 — LMSummarizer.
 */

import { describe, it, expect } from 'vitest'
import { LMSummarizer, NoOpLMSummarizer, type LanguageModel } from '../src/core/ctfReasoning/lmSummarizer.js'
import { createTestTaskState } from './fixtures/createTestTaskState.js'
import { createObservation } from '../src/core/ctfReasoning/observation.js'

describe('LMSummarizer (C3)', () => {
  it('calls the underlying model and returns a summary', async () => {
    const state = createTestTaskState({ taskId: 'c3-1' })
    const obs = [
      createObservation(state.taskId, { kind: 'file_type', source: { type: 'tool' }, summary: 'PNG image', confidence: 0.9 }),
      createObservation(state.taskId, { kind: 'flag_like_text', source: { type: 'tool' }, summary: 'flag{test}', confidence: 0.7 }),
    ]
    const sum = new LMSummarizer(new NoOpLMSummarizer())
    const out = await sum.summarize({ taskId: state.taskId, observations: obs, maxLength: 200 })
    expect(out.text.length).toBeGreaterThan(0)
    expect(out.categories).toContain('file_type')
    expect(out.claims.length).toBeGreaterThan(0)
  })

  it('custom LanguageModel produces custom output', async () => {
    const customLM: LanguageModel = {
      async generate(_prompt: string): Promise<string> {
        return '- claim: custom result\n- category: misc\n- question: ?'
      },
    }
    const state = createTestTaskState({ taskId: 'c3-2' })
    const obs = [
      createObservation(state.taskId, { kind: 'generic', source: { type: 'tool' }, summary: 'obs', confidence: 0.5 }),
    ]
    const sum = new LMSummarizer(customLM)
    const out = await sum.summarize({ taskId: state.taskId, observations: obs, maxLength: 100 })
    expect(out.claims).toContain('custom result')
    expect(out.categories).toContain('misc')
    expect(out.openQuestions).toContain('?')
  })

  it('falls back to observation summary when no structured lines present', async () => {
    const sum = new LMSummarizer(new NoOpLMSummarizer())
    const state = createTestTaskState({ taskId: 'c3-3' })
    const obs = [
      createObservation(state.taskId, { kind: 'file_magic', source: { type: 'tool' }, summary: 'magic 1', confidence: 0.5 }),
      createObservation(state.taskId, { kind: 'file_magic', source: { type: 'tool' }, summary: 'magic 2', confidence: 0.5 }),
    ]
    const out = await sum.summarize({ taskId: state.taskId, observations: obs, maxLength: 100 })
    expect(out.claims.length).toBeGreaterThan(0)
    expect(out.categories).toContain('file_magic')
  })
})
