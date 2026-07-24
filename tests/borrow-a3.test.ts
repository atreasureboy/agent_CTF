/**
 * Phase A3 — block-unless-regex.
 */

import { describe, it, expect } from 'vitest'
import {
  buildBlockUnlessRegex,
  checkBlockUnlessRegex,
  inputToString,
} from '../src/core/toolBroker/blockUnlessRegex.js'

describe('BlockUnlessRegex (A3)', () => {
  it('allows calls that match the regex', () => {
    const cfg = buildBlockUnlessRegex([
      ['radare2', /\b(?:radare2)\b.*\s+-c\s+.*/],
    ])
    const r = checkBlockUnlessRegex(cfg, 'radare2', { cmd: 'radare2 -c "pdf @ main"' })
    expect(r.allowed).toBe(true)
    expect(r.reason).toBe('matched')
  })

  it('rejects calls that do not match', () => {
    const cfg = buildBlockUnlessRegex([
      ['radare2', /\b(?:radare2)\b.*\s+-c\s+.*/],
    ])
    const r = checkBlockUnlessRegex(cfg, 'radare2', { interactive: true })
    expect(r.allowed).toBe(false)
    expect(r.reason).toBe('block_unless_regex_failed')
  })

  it('returns no_rule when toolId is not in the config', () => {
    const cfg = buildBlockUnlessRegex([])
    const r = checkBlockUnlessRegex(cfg, 'file', { path: '/x' })
    expect(r.allowed).toBe(true)
    expect(r.reason).toBe('no_rule')
  })

  it('matches against string input directly', () => {
    const cfg = buildBlockUnlessRegex([
      ['shell', /^echo\s+/],
    ])
    expect(checkBlockUnlessRegex(cfg, 'shell', 'echo hello').allowed).toBe(true)
    expect(checkBlockUnlessRegex(cfg, 'shell', 'rm -rf /').allowed).toBe(false)
  })

  it('inputToString handles nested objects', () => {
    expect(inputToString({ a: 1, b: [2, 3] })).toBe('{"a":1,"b":[2,3]}')
    expect(inputToString(null)).toBe('')
    expect(inputToString('hello')).toBe('hello')
  })
})
