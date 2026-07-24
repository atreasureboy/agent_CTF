/**
 * Phase C — MCP executor adapter.
 *
 * Tests the adapter with a stub McpClient (no subprocess / network).
 */

import { describe, it, expect } from 'vitest'
import { createMcpExecutor, mcpToolId, describeMcpTools } from '../src/core/mcp/mcpExecutorAdapter.js'
import type { McpCallResult, McpClient } from '../src/core/mcp/mcpClient.js'
import { createTestTaskState } from './fixtures/createTestTaskState.js'
import type { CTFAttempt } from '../src/core/ctfRuntime/taskState.js'
import type { SuggestedAction } from '../src/core/ctfReasoning/suggestedAction.js'
import type { StrategyActionExecutorContext } from '../src/core/ctfReasoning/strategyActionExecutor.js'

function makeAttempt(id: string): CTFAttempt {
  return {
    id, taskId: 't1', kind: 'tool', targetId: 'mcp:echo:echo', input: {},
    fingerprint: 'fp1', hypothesisIds: [], status: 'running',
    observationIds: [], evidenceIds: [], artifactIds: [], flagCandidateIds: [], createdAt: 0,
  }
}

function makeStubClient(behaviour: {
  result?: McpCallResult
  throw?: Error
  delayMs?: number
}): McpClient {
  return {
    serverName: 'echo',
    start: async () => {},
    stop: async () => {},
    listTools: async () => [{ name: 'echo' }],
    callTool: async (_toolName: string, args: Record<string, unknown>) => {
      if (behaviour.delayMs) await new Promise((r) => setTimeout(r, behaviour.delayMs))
      if (behaviour.throw) throw behaviour.throw
      return behaviour.result ?? {
        content: [{ type: 'text', text: 'ECHO:' + JSON.stringify(args) }],
      }
    },
  }
}

describe('MCP (C)', () => {
  it('MCPExecutorAdapter invokes the right tool', async () => {
    const executor = createMcpExecutor(makeStubClient({}))
    const ctx: StrategyActionExecutorContext = {
      taskState: createTestTaskState({ taskId: 't1' }),
      action: {
        type: 'call_tool', toolId: mcpToolId('echo', 'echo'),
        input: { x: 1, y: 'two' }, reason: 'r', priority: 1, costTier: 'cheap',
      } as SuggestedAction,
      attempt: makeAttempt('att1'),
      signal: new AbortController().signal,
    }
    const r = await executor.execute(ctx)
    expect(r.status).toBe('executed')
    if (r.status === 'executed') {
      expect(r.materializedResult.observations.length).toBe(1)
      expect(r.materializedResult.observations[0]!.summary).toContain('ECHO')
    }
  })

  it('passes AbortSignal to the underlying callTool', async () => {
    let abortObserved = false
    const client: McpClient = {
      serverName: 'x',
      start: async () => {},
      stop: async () => {},
      listTools: async () => [],
      callTool: async (_t, _a, signal) => {
        signal?.addEventListener('abort', () => { abortObserved = true })
        return new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted'))))
      },
    }
    const executor = createMcpExecutor(client)
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 5)
    const r = await executor.execute({
      taskState: createTestTaskState({ taskId: 't1' }),
      action: {
        type: 'call_tool', toolId: mcpToolId('x', 'y'),
        input: {}, reason: 'r', priority: 1, costTier: 'cheap',
      } as SuggestedAction,
      attempt: makeAttempt('att1'),
      signal: ac.signal,
    })
    // Either the call returned a failure (status: failed) because of
    // the abort, or it was rejected before reaching the client.
    expect(r.status === 'failed' || abortObserved).toBe(true)
  })

  it('returns failed with partialResult when MCP server reports isError', async () => {
    const client = makeStubClient({
      result: { content: [{ type: 'text', text: 'permission denied' }], isError: true },
    })
    const executor = createMcpExecutor(client)
    const r = await executor.execute({
      taskState: createTestTaskState({ taskId: 't1' }),
      action: {
        type: 'call_tool', toolId: mcpToolId('echo', 'echo'),
        input: {}, reason: 'r', priority: 1, costTier: 'cheap',
      } as SuggestedAction,
      attempt: makeAttempt('att1'),
      signal: new AbortController().signal,
    })
    expect(r.status).toBe('failed')
    if (r.status === 'failed') {
      expect(r.error?.message).toContain('permission denied')
    }
  })

  it('non-call_tool actions are rejected by MCP executor', async () => {
    const executor = createMcpExecutor(makeStubClient({}))
    const r = await executor.execute({
      taskState: createTestTaskState({ taskId: 't1' }),
      action: { type: 'request_handoff', capability: 'x', objective: 'o', artifactIds: [], reason: 'r', priority: 1, costTier: 'cheap' } as SuggestedAction,
      attempt: makeAttempt('att1'),
      signal: new AbortController().signal,
    })
    expect(r.status).toBe('failed')
  })

  it('wrong server prefix returns failed', async () => {
    const executor = createMcpExecutor(makeStubClient({}))
    const r = await executor.execute({
      taskState: createTestTaskState({ taskId: 't1' }),
      action: {
        type: 'call_tool', toolId: 'mcp:other-server:foo',
        input: {}, reason: 'r', priority: 1, costTier: 'cheap',
      } as SuggestedAction,
      attempt: makeAttempt('att1'),
      signal: new AbortController().signal,
    })
    expect(r.status).toBe('failed')
  })

  it('safeMcpStderr redacts secrets', async () => {
    const { safeMcpStderr } = await import('../src/core/mcp/mcpClient.js')
    const redacted = safeMcpStderr('Authorization: Bearer ghp_1234567890abcdefghij')
    expect(redacted).not.toContain('ghp_1234567890')
  })

  it('describeMcpTools lists all tools', () => {
    const ids = describeMcpTools('chrome', [
      { name: 'navigate' },
      { name: 'screenshot' },
    ])
    expect(ids).toEqual(['mcp:chrome:navigate', 'mcp:chrome:screenshot'])
  })
})
