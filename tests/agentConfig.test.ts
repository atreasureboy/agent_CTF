import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  contextTokensForModel,
  loadAgentConfig,
  MODEL_CONTEXT_TOKENS,
  DEFAULT_CONTEXT_TOKENS,
} from '../src/config/agentConfig.js'

let workDir: string

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'acfg-'))
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

describe('contextTokensForModel', () => {
  it('returns the exact match from the map', () => {
    expect(contextTokensForModel('gpt-4o')).toBe(MODEL_CONTEXT_TOKENS['gpt-4o'])
    expect(contextTokensForModel('claude-sonnet-4-x')).toBe(200_000)
  })

  it('prefix-matches dated model variants', () => {
    expect(contextTokensForModel('gpt-4o-2024-08-06')).toBe(MODEL_CONTEXT_TOKENS['gpt-4o'])
  })

  it('falls back to the default for unknown models', () => {
    expect(contextTokensForModel('some-future-model')).toBe(DEFAULT_CONTEXT_TOKENS)
  })

  it('an explicit override wins over the map', () => {
    expect(contextTokensForModel('gpt-4o', 50_000)).toBe(50_000)
  })
})

describe('loadAgentConfig', () => {
  it('returns {} when no config files exist', () => {
    expect(loadAgentConfig(workDir)).toEqual({})
  })

  it('reads a project-level .ovogo/agent.json', () => {
    const cfgDir = join(workDir, '.ovogo')
    mkdirSync(cfgDir, { recursive: true })
    writeFileSync(join(cfgDir, 'agent.json'), JSON.stringify({
      model: 'claude-sonnet-4-x',
      modules: ['memory'],
      permission: { mode: 'ask', rules: [{ tool: 'Bash', action: 'deny' }] },
      mcpServers: { time: { command: 'node' } },
      verifyCommands: ['npm test'],
      pricing: { inputPer1M: 3 },
    }), 'utf8')

    const cfg = loadAgentConfig(workDir)
    expect(cfg.model).toBe('claude-sonnet-4-x')
    expect(cfg.modules).toEqual(['memory'])
    expect(cfg.permission?.mode).toBe('ask')
    expect(cfg.permission?.rules).toHaveLength(1)
    expect(cfg.mcpServers?.time.command).toBe('node')
    expect(cfg.verifyCommands).toEqual(['npm test'])
    expect(cfg.pricing?.inputPer1M).toBe(3)
  })

  it('survives a malformed config file (no throw, no model resolved)', () => {
    const cfgDir = join(workDir, '.ovogo')
    mkdirSync(cfgDir, { recursive: true })
    writeFileSync(join(cfgDir, 'agent.json'), '{ broken', 'utf8')
    const cfg = loadAgentConfig(workDir)
    expect(cfg.model).toBeUndefined()
    expect(cfg.modules).toBeUndefined()
    expect(cfg.mcpServers).toEqual({})
  })
})
