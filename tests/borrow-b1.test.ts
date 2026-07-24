/**
 * Phase B1 — AutoPrompter.
 */

import { describe, it, expect } from 'vitest'
import { TemplateAutoPrompter, safeGenerate } from '../src/core/ctfReasoning/autoPrompter.js'
import type { SuggestedAction } from '../src/core/ctfReasoning/suggestedAction.js'

const baseAction: SuggestedAction = {
  type: 'call_tool',
  toolId: 'file',
  input: { path: '/x' },
  reason: 'r',
  priority: 5,
  costTier: 'cheap',
}

describe('AutoPrompter (B1)', () => {
  it('template-based framing is category-aware', async () => {
    const prompter = new TemplateAutoPrompter()
    const out = await prompter.generate({
      taskId: 't1',
      category: 'crypto',
      rawPrompt: 'solve this',
      suggestedActions: [baseAction],
    })
    expect(out.framing).toContain('crypto')
    expect(out.framing).toContain('known primitives')
    expect(out.notes).toContain('template-driven')
  })

  it('pwn framing mentions checksec / UAF', async () => {
    const prompter = new TemplateAutoPrompter()
    const out = await prompter.generate({
      taskId: 't1', category: 'pwn', rawPrompt: '',
      suggestedActions: [],
    })
    expect(out.framing.toLowerCase()).toContain('checksec')
  })

  it('web framing mentions cookies / XSS / SQLi', async () => {
    const prompter = new TemplateAutoPrompter()
    const out = await prompter.generate({
      taskId: 't1', category: 'web', rawPrompt: '',
      suggestedActions: [],
    })
    expect(out.framing.toLowerCase()).toContain('cookies')
  })

  it('reverse framing mentions file / strings', async () => {
    const prompter = new TemplateAutoPrompter()
    const out = await prompter.generate({
      taskId: 't1', category: 'reverse', rawPrompt: '',
      suggestedActions: [],
    })
    expect(out.framing.toLowerCase()).toContain('strings')
  })

  it('safeGenerate returns undefined on error', async () => {
    const failingPrompter = {
      generate: () => Promise.reject(new Error('LLM offline')),
    }
    const out = await safeGenerate(failingPrompter, {
      taskId: 't1', category: 'misc', rawPrompt: '',
      suggestedActions: [],
    })
    expect(out).toBeUndefined()
  })
})
