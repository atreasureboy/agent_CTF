/**
 * Phase D3 — LLM tool-use protocol.
 */

import { describe, it, expect } from 'vitest'
import {
  askLlmForAction,
  MockLlmProvider,
  type ToolUseRequest,
} from '../src/core/llm/llmToolUse.js'

describe('LLM tool-use protocol (D3)', () => {
  it('returns ok when the LLM emits a valid action', async () => {
    const req: ToolUseRequest = {
      id: 'r1',
      raw: {
        type: 'call_tool',
        toolId: 'file',
        input: { path: '/tmp/x' },
        reason: 'identify file',
        priority: 1,
        costTier: 'cheap',
      },
    }
    const provider = new MockLlmProvider('mock-1', req)
    const r = await askLlmForAction(provider, 'find the file', [
      { name: 'file', description: 'identify file', inputSchema: { type: 'object' } },
    ])
    expect(r.kind).toBe('ok')
    if (r.kind === 'ok') {
      expect(r.action.type).toBe('call_tool')
      if (r.action.type === 'call_tool') {
        expect(r.action.toolId).toBe('file')
      }
    }
  })

  it('returns invalid when the LLM emits malformed JSON', async () => {
    const req: ToolUseRequest = {
      id: 'r2',
      raw: { type: 'call_tool' /* missing toolId, input, etc. */ },
    }
    const provider = new MockLlmProvider('mock-2', req)
    const r = await askLlmForAction(provider, 'p', [])
    expect(r.kind).toBe('invalid')
  })

  it('returns no-tool-call when the LLM emits free-form text', async () => {
    const provider = new MockLlmProvider('mock-3', null)
    const r = await askLlmForAction(provider, 'p', [])
    expect(r.kind).toBe('no-tool-call')
  })

  it('MockLlmProvider can swap responses between calls', async () => {
    const provider = new MockLlmProvider('mock-4')
    provider.setNext({ id: 'a', raw: { type: 'call_tool', toolId: 'f', input: {}, reason: 'r', priority: 1, costTier: 'cheap' } })
    const r1 = await askLlmForAction(provider, 'p', [])
    expect(r1.kind).toBe('ok')
    provider.setNext(null)
    const r2 = await askLlmForAction(provider, 'p', [])
    expect(r2.kind).toBe('no-tool-call')
  })
})
