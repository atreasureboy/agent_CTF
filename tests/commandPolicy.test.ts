/**
 * Bash command policy — short-circuit enforcement at the BashTool level.
 */

import { describe, expect, it } from 'vitest'

import {
  evaluateCommandPolicy,
  firstExecutable,
  extractNetworkTargets,
} from '../src/tools/commandPolicy.js'
import { BashTool } from '../src/tools/bash.js'
import { PROFILES } from '../src/capabilityProfiles/builtin.js'
import { ContestScopeChecker, parseContestScope } from '../src/core/contestScope.js'

describe('firstExecutable', () => {
  it('returns the first binary token from a simple command', () => {
    expect(firstExecutable('ls -la')).toBe('ls')
  })
  it('handles sudo prefix', () => {
    expect(firstExecutable('sudo apt update')).toBe('apt')
  })
  it('skips env var assignments', () => {
    expect(firstExecutable('FOO=bar BAZ=1 nmap -sV localhost')).toBe('nmap')
  })
  it('returns null for empty', () => {
    expect(firstExecutable('   ')).toBe(null)
  })
})

describe('extractNetworkTargets', () => {
  it('extracts URL from curl', () => {
    expect(extractNetworkTargets('curl http://example.com/path')).toContain('http://example.com/path')
  })
  it('extracts host:port from nmap', () => {
    const result = extractNetworkTargets('nmap -sV 10.0.0.1')
    expect(result.join(' ')).toMatch(/10\.0\.0\.1/)
  })
})

describe('evaluateCommandPolicy', () => {
  it('denies bash outright when allowShell=false', () => {
    // orchestrator profile uses allowShell=false by default
    const v = evaluateCommandPolicy({ command: 'ls', profile: PROFILES['orchestrator'] })
    expect(v.allowed).toBe(false)
    expect(v.reason).toMatch(/allowShell=false/)
  })

  it('denies when first token is in deniedCommands', () => {
    const profile = { ...PROFILES['image-stego'], deniedCommands: ['nmap'] }
    const v = evaluateCommandPolicy({ command: 'nmap -sV localhost', profile })
    expect(v.allowed).toBe(false)
    expect(v.firstExecutable).toBe('nmap')
  })

  it('denies when allowlist is set and the binary is not in it', () => {
    const profile = { ...PROFILES['image-stego'], allowedCommands: ['zsteg'], deniedCommands: undefined }
    const v = evaluateCommandPolicy({ command: 'curl http://target/', profile })
    expect(v.allowed).toBe(false)
  })

  it('allows the binary when it is in allowedCommands', () => {
    const profile = { ...PROFILES['image-stego'], allowedCommands: ['zsteg'] }
    const v = evaluateCommandPolicy({ command: 'zsteg -a a.png', profile })
    expect(v.allowed).toBe(true)
  })

  it('allows shell built-ins without consulting denied/allowed lists', () => {
    const profile = { ...PROFILES['image-stego'], deniedCommands: ['echo'] }
    const v = evaluateCommandPolicy({ command: 'echo hello', profile })
    expect(v.allowed).toBe(true)
    expect(v.firstExecutable).toBe('echo')
  })

  it('enforces contest network scope', () => {
    const profile = PROFILES['image-stego']
    const checker = new ContestScopeChecker(
      parseContestScope({
        allowedFilesRoot: '/tmp',
        allowPublicNetwork: false,
        allowedHosts: ['allowed.example'],
      }),
    )

    const yesRun = evaluateCommandPolicy({ command: 'curl http://allowed.example/path', profile, contestScope: checker })
    expect(yesRun.allowed).toBe(true)

    const noRun = evaluateCommandPolicy({ command: 'curl http://blocked.example/', profile, contestScope: checker })
    expect(noRun.allowed).toBe(false)
  })
})

describe('BashTool integration with policy', () => {
  it('returns structured refusal when policy denies', async () => {
    const bash = new BashTool()
    const profile = { ...PROFILES['image-stego'], deniedCommands: ['ls'] }
    const eventLog = {
      append: () => ({})
    } as unknown as import('../src/core/eventLog.js').EventLog
    const ctx = {
      cwd: '/tmp',
      permissionMode: 'auto' as const,
      __ctf: {
        taskId: 't1',
        agentId: 'image-stego',
        profile,
        eventLog,
      },
    } as unknown as import('../src/core/types.js').ToolContext

    const result = await bash.execute({ command: 'ls -la' }, ctx)
    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/denied by profile/)
  })

  it('passes through when policy allows', async () => {
    const bash = new BashTool()
    const profile = PROFILES['image-stego']
    const eventLog = { append: () => ({}) } as unknown as import('../src/core/eventLog.js').EventLog
    const ctx = {
      cwd: '/tmp',
      permissionMode: 'auto' as const,
      signal: new AbortController().signal,
      __ctf: { taskId: 't1', agentId: 'image-stego', profile, eventLog },
    } as unknown as import('../src/core/types.js').ToolContext
    const result = await bash.execute({ command: 'echo from-policy-test-OK' }, ctx)
    expect(result.isError).toBe(false)
    expect(result.content).toMatch(/from-policy-test-OK/)
  })
})
