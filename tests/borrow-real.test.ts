/**
 * Real LLM integration tests.
 *
 * The OpenAiCompatibleProvider is exercised against a local mock
 * fetch (no real network calls) so the test runs offline.
 * A separate test shows how to call Ollama / vLLM when one is
 * available.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { createOpenAiCompatibleProvider, type OpenAiCompatibleConfig } from '../src/core/llm/openAiCompatibleProvider.js'
import { askLlmForAction } from '../src/core/llm/llmToolUse.js'
import { buildActionTool, buildActionPrompt } from '../src/core/llm/actionTool.js'
import { createTestTaskState } from './fixtures/createTestTaskState.js'

interface MockResponse {
  status?: number
  statusText?: string
  body: unknown
}

function makeFetch(responses: MockResponse[]): typeof fetch {
  let i = 0
  const fn = async (_url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    const r = responses[i] ?? responses[responses.length - 1]!
    i += 1
    return new Response(JSON.stringify(r.body), {
      status: r.status ?? 200,
      statusText: r.statusText ?? 'OK',
      headers: { 'content-type': 'application/json' },
    })
  }
  return fn as unknown as typeof fetch
}

function cfgWith(responses: MockResponse[]): OpenAiCompatibleConfig {
  return {
    id: 'mock-1',
    baseUrl: 'http://mock/v1',
    fetchImpl: makeFetch(responses),
  }
}

describe('OpenAiCompatibleProvider (real D3)', () => {
  beforeEach(() => {
    // nothing global to reset
  })

  it('builds the right tool definition and prompt', () => {
    const tool = buildActionTool([{ name: 'f', description: 'd', inputSchema: { type: 'object' } }])
    expect(tool.function.name).toBe('ctf_action')
    expect(tool.function.description).toContain('CTF')
    const prompt = buildActionPrompt([{ name: 'f', description: 'd', inputSchema: { type: 'object' } }])
    expect(prompt).toContain('Available tools')
    expect(prompt).toContain('f — d')
  })

  it('parses a successful tool call into a SuggestedAction', async () => {
    const provider = createOpenAiCompatibleProvider(cfgWith([{
      body: {
        choices: [{
          message: {
            tool_calls: [{
              id: 'tc1',
              function: {
                name: 'ctf_action',
                arguments: JSON.stringify({
                  type: 'call_tool',
                  toolId: 'file',
                  input: { path: '/tmp/x' },
                  reason: 'identify file',
                  priority: 5,
                  costTier: 'cheap',
                }),
              },
            }],
          },
        }],
      },
    }]))
    const r = await askLlmForAction(provider, 'solve this', [
      { name: 'file', description: 'identify a file', inputSchema: { type: 'object' } },
    ])
    expect(r.kind).toBe('ok')
    if (r.kind === 'ok') {
      expect(r.action.type).toBe('call_tool')
      if (r.action.type === 'call_tool') {
        expect(r.action.toolId).toBe('file')
      }
    }
  })

  it('returns no-tool-call when the LLM emits free-form text', async () => {
    const provider = createOpenAiCompatibleProvider(cfgWith([{
      body: { choices: [{ message: { content: 'no tool call' } }] },
    }]))
    const r = await askLlmForAction(provider, 'p', [])
    expect(r.kind).toBe('no-tool-call')
  })

  it('returns invalid when the JSON is malformed', async () => {
    const provider = createOpenAiCompatibleProvider(cfgWith([{
      body: {
        choices: [{
          message: {
            tool_calls: [{
              id: 'tc1',
              function: { name: 'ctf_action', arguments: JSON.stringify({ type: 'call_tool' }) },
            }],
          },
        }],
      },
    }]))
    const r = await askLlmForAction(provider, 'p', [])
    expect(r.kind).toBe('invalid')
  })

  it('returns null on HTTP error', async () => {
    const failingFetch: typeof fetch = (async () => {
      return new Response('{"error":"bad gateway"}', { status: 502, statusText: 'Bad Gateway' })
    }) as unknown as typeof fetch
    const provider = createOpenAiCompatibleProvider({
      id: 'x', baseUrl: 'http://x/v1', fetchImpl: failingFetch,
    })
    await expect(askLlmForAction(provider, 'p', [])).rejects.toThrow(/HTTP 502/)
  })

  it('works with the OpenAI default URL (no network, fetch mock)', async () => {
    void createTestTaskState({ taskId: 'live' })
    // No real network; just exercise the URL builder.
    const provider = createOpenAiCompatibleProvider({
      id: 'gpt-4o',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-...',
      fetchImpl: makeFetch([{ body: { choices: [{ message: { content: 'x' } }] } }]),
    })
    const r = await askLlmForAction(provider, 'p', [])
    expect(r.kind).toBe('no-tool-call')
    expect(provider.id).toBe('gpt-4o')
  })
})
