/**
 * End-to-end Engine test — drives a real Engine.runTurn with a scripted
 * mock OpenAI client. Asserts that the LLM's tool calls actually flow
 * through the ToolBroker, that Findings/Handoffs persist, and that the
 * multi-turn loop terminates with a final assistant message.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type OpenAI from 'openai'

import { createHarness } from '../src/core/harness.js'
import { ExecutionEngine } from '../src/core/engine.js'
import type { EngineConfig } from '../src/core/types.js'
import { Renderer } from '../src/ui/renderer.js'

import { ScriptedClient } from './mockOpenAIClient.js'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'engine-e2e-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function makeEngine(opts: {
  client: OpenAI
  broker: NonNullable<EngineConfig['broker']>
  taskId: string
  cwd: string
}) {
  const config: EngineConfig = {
    client: opts.client,
    cwd: opts.cwd,
    apiKey: 'mock-key',
    baseURL: 'http://localhost',
    model: 'mock',
    maxIterations: 4,
    permissionMode: 'auto',
    sessionDir: join(root, 'session'),
    broker: opts.broker,
    taskId: opts.taskId,
    agentId: 'image-stego',
    systemPrompt: 'You are an image-stego agent.',
    temperature: 0,
  }
  return new ExecutionEngine(config, new Renderer())
}

function readEvents(filePath: string): Array<Record<string, unknown>> {
  try {
    const txt = readFileSync(filePath, 'utf8').trim()
    if (!txt) return []
    return txt.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
  } catch {
    return []
  }
}

describe('e2e Engine.runTurn — image-stego agent with scripted LLM', () => {
  it('drives a multi-turn LLM↔Tool loop, persists Findings + Handoffs, terminates', async () => {
    const h = createHarness({
      cwd: root,
      profile: 'image-stego',
      inlineMaxBytes: 1024,
      jobLimits: { maxPerAgent: 0, maxPerTask: 0 },
    })
    const client = new ScriptedClient()
    client.script = [
      {
        callIndex: 0,
        actions: [
          {
            type: 'tool_call',
            toolName: 'emit_finding',
            args: {
              category: 'image',
              title: 'PNG magic 89504E47',
              summary: 'first 8 bytes match PNG signature',
              confidence: 'high',
            },
          },
          {
            type: 'tool_call',
            toolName: 'request_handoff',
            args: {
              suggestedAgent: 'file-forensics',
              reason: 'PNG contains nested ZIP — needs archive extraction',
              objective: 'Recursively extract archive and submit follow-up findings',
            },
          },
          { type: 'text', content: 'Detection + handoff complete.' },
          { type: 'finish', reason: 'stop', usage: { prompt: 50, completion: 25 } },
        ],
      },
    ]
    client.defaultTurn = {
      actions: [
        { type: 'text', content: '(no further action needed)' },
        { type: 'finish', reason: 'stop', usage: { prompt: 10, completion: 5 } },
      ],
    }

    const engine = makeEngine({
      client: client as unknown as OpenAI,
      broker: h.broker,
      taskId: h.taskWorkspace.paths.taskId,
      cwd: root,
    })
    const { result, newHistory } = await engine.runTurn('Solve ctf.png', [])

    expect(result.stopped).toBe(true)
    expect(['stop_sequence', 'max_iterations']).toContain(result.reason)

    const findings = h.findingStore.list()
    expect(findings.length).toBe(1)
    expect(findings[0].category).toBe('image')
    expect(findings[0].title).toMatch(/PNG magic/)

    const handoffs = h.handoffStore.list()
    expect(handoffs.length).toBe(1)
    expect(handoffs[0].suggestedAgent).toBe('file-forensics')
    expect(handoffs[0].status).toBe('pending')

    const toolMessages = newHistory.filter((m) => m.role === 'tool')
    expect(toolMessages.length).toBeGreaterThanOrEqual(2)

    const evts = readEvents(h.taskWorkspace.paths.eventsFile)
    expect(evts.some((e) => e.type === 'tool_call')).toBe(true)
    expect(evts.some((e) => e.type === 'tool_result')).toBe(true)
  })

  it('blocks Bash commands that bypass profile via the broker', async () => {
    const h = createHarness({
      cwd: root, profile: 'image-stego',
      inlineMaxBytes: 1024, jobLimits: { maxPerAgent: 0, maxPerTask: 0 },
    })
    const client = new ScriptedClient()
    client.script = [
      {
        callIndex: 0,
        actions: [
          { type: 'tool_call', toolName: 'Bash', args: { command: 'nmap -sV example.com' } },
          { type: 'text', content: 'tried' },
          { type: 'finish', reason: 'stop', usage: { prompt: 30, completion: 5 } },
        ],
      },
    ]
    client.defaultTurn = {
      actions: [{ type: 'text', content: 'done' }, { type: 'finish', reason: 'stop', usage: { prompt: 10, completion: 2 } }],
    }
    const engine = makeEngine({
      client: client as unknown as OpenAI,
      broker: h.broker,
      taskId: h.taskWorkspace.paths.taskId,
      cwd: root,
    })
    const { newHistory } = await engine.runTurn('enumerate', [])
    const toolMsg = newHistory.find((m) => m.role === 'tool' && m.content?.toString().includes('nmap'))
    expect(toolMsg).toBeTruthy()
  })

  it('orchestrator profile refuses Bash (deniedTools + allowShell=false)', async () => {
    const h = createHarness({
      cwd: root, profile: 'orchestrator',
      inlineMaxBytes: 1024, jobLimits: { maxPerAgent: 0, maxPerTask: 0 },
    })
    const client = new ScriptedClient()
    client.script = [
      {
        callIndex: 0,
        actions: [
          { type: 'tool_call', toolName: 'Bash', args: { command: 'ls -la' } },
          { type: 'text', content: 'tried bash' },
          { type: 'finish', reason: 'stop', usage: { prompt: 30, completion: 5 } },
        ],
      },
    ]
    client.defaultTurn = {
      actions: [{ type: 'text', content: 'done' }, { type: 'finish', reason: 'stop', usage: { prompt: 10, completion: 2 } }],
    }
    const engine = makeEngine({
      client: client as unknown as OpenAI,
      broker: h.broker,
      taskId: h.taskWorkspace.paths.taskId,
      cwd: root,
    })
    const { newHistory } = await engine.runTurn('list', [])
    const toolMsg = newHistory.find((m) => m.role === 'tool' && m.content?.toString().toLowerCase().includes('denied'))
    expect(toolMsg).toBeTruthy()
  })
})

describe('e2e Engine.runTurn — ToolFirstPolicy audit through the engine', () => {
  it('records a policy_advisory event when a Bash command triggers image-stego rule', async () => {
    const h = createHarness({
      cwd: root, profile: 'image-stego',
      inlineMaxBytes: 1024, jobLimits: { maxPerAgent: 0, maxPerTask: 0 },
    })
    const client = new ScriptedClient()
    client.script = [
      {
        callIndex: 0,
        actions: [
          { type: 'tool_call', toolName: 'Bash', args: { command: 'python3 extract_lsb.py logo.png' } },
          { type: 'finish', reason: 'stop', usage: { prompt: 10, completion: 2 } },
        ],
      },
    ]
    client.defaultTurn = {
      actions: [{ type: 'text', content: 'done' }, { type: 'finish', reason: 'stop', usage: { prompt: 10, completion: 2 } }],
    }
    const engine = makeEngine({
      client: client as unknown as OpenAI,
      broker: h.broker,
      taskId: h.taskWorkspace.paths.taskId,
      cwd: root,
    })
    await engine.runTurn('image-stego', [])
    const evts = readEvents(h.taskWorkspace.paths.eventsFile)
    const advisories = evts.filter((e) => e.type === 'policy_advisory')
    expect(advisories.length).toBeGreaterThan(0)
    const detail = advisories[0].detail as { tool?: string; rule?: string }
    expect(detail.tool).toBe('Bash')
    expect(detail.rule).toBe('image-stego')
  })
})
