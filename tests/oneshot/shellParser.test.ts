import { describe, it, expect } from 'vitest'
import {
  parseShellCommand,
  allExecutablesShellSafe,
  firstExecutableSafe,
} from '../../src/tools/shellParser.js'
import { evaluateCommandPolicy } from '../../src/tools/commandPolicy.js'
import { safeParseCapabilityProfile } from '../../src/core/capabilityProfile.js'

const profile = safeParseCapabilityProfile({
  id: 'triage',
  displayName: 'Triage',
  allowShell: true,
  allowedCommands: ['echo', 'cat', 'curl', 'file'],
  deniedCommands: ['nmap'],
})
if (!profile) throw new Error('profile parse failed')

describe('shellParser (state-machine splitter)', () => {
  it('parses a plain command', () => {
    const r = parseShellCommand('curl https://ctf.example.com/file')
    expect(r.unknown).toBe(false)
    expect(r.segments).toHaveLength(1)
    expect(r.segments[0].firstExecutable).toBe('curl')
  })

  it('parses semicolon chains', () => {
    const r = parseShellCommand('echo ok; nmap evil.com')
    expect(r.unknown).toBe(false)
    expect(r.segments.map((s) => s.firstExecutable)).toEqual(['echo', 'nmap'])
  })

  it('parses && chains', () => {
    const r = parseShellCommand('true && curl https://ctf.example.com && nmap evil')
    expect(r.segments.map((s) => s.firstExecutable)).toEqual(['true', 'curl', 'nmap'])
  })

  it('parses pipes correctly', () => {
    const r = parseShellCommand('cat foo | grep secret | nmap target')
    expect(r.segments.map((s) => s.firstExecutable)).toEqual(['cat', 'grep', 'nmap'])
  })

  it('handles assignments', () => {
    const r = parseShellCommand('FOO=bar curl https://ctf.example.com')
    expect(r.segments[0].firstExecutable).toBe('curl')
  })

  it('handles sudo / env prefixes', () => {
    const r = parseShellCommand('sudo -E nmap evil.com')
    expect(r.segments[0].firstExecutable).toBe('nmap')
  })

  it('handles balanced subshells', () => {
    const r = parseShellCommand('(echo ok; nmap evil.com)')
    expect(r.unknown).toBe(false)
    expect(r.segments).toHaveLength(1)
    expect(r.segments[0].firstExecutable).toBe('echo')
  })

  it('handles nested command substitution', () => {
    const r = parseShellCommand('curl $(echo ctf.example.com)')
    expect(r.unknown).toBe(false)
    expect(r.segments[0].firstExecutable).toBe('curl')
  })

  it('flags commands with unbalanced quotes', () => {
    const r = parseShellCommand('echo "unterminated')
    expect(r.unknown).toBe(true)
  })

  it('flags commands with unbalanced subshells', () => {
    const r = parseShellCommand('echo $(nmap')
    expect(r.unknown).toBe(true)
  })

  it('allExecutablesShellSafe returns [] on unparseable input', () => {
    const r = allExecutablesShellSafe('echo "unterminated && nmap')
    expect(r.unknown).toBe(true)
    expect(r.executables).toEqual([])
  })

  it('firstExecutableSafe returns null for unparseable input', () => {
    expect(firstExecutableSafe('(echo ok && nmap')).toBeNull()
  })

  it('evaluateCommandPolicy fail-closes on unparseable commands', () => {
    const r = evaluateCommandPolicy({
      command: 'echo "unterminated && nmap evil',
      profile,
    })
    expect(r.allowed).toBe(false)
    expect(r.unknown).toBe(true)
  })

  it('evaluateCommandPolicy denies deniedCommand in semicolon chain', () => {
    const r = evaluateCommandPolicy({
      command: 'echo ok; nmap evil.com',
      profile,
    })
    expect(r.allowed).toBe(false)
    expect(r.reason).toMatch(/nmap/)
  })
})
