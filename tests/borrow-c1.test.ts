/**
 * Phase C1 — ToolVisibility scoping.
 */

import { describe, it, expect } from 'vitest'
import {
  PERMISSIVE_VISIBILITY,
  DEFAULT_VISIBILITY,
  checkVisibility,
} from '../src/core/ctfReasoning/toolVisibility.js'

describe('ToolVisibility (C1)', () => {
  it('permissive visibility allows everything', () => {
    const r = checkVisibility(PERMISSIVE_VISIBILITY, 'orchestrator', 'arbitrary_tool')
    expect(r.allowed).toBe(true)
    expect(r.reason).toBe('role_allowed') // permissive: empty universal + empty role sets
  })

  it('default visibility: orchestrator can verify_flag but not decompile', () => {
    expect(checkVisibility(DEFAULT_VISIBILITY, 'orchestrator', 'verify_flag').allowed).toBe(true)
    expect(checkVisibility(DEFAULT_VISIBILITY, 'orchestrator', 'decompile').allowed).toBe(false)
  })

  it('default visibility: reverse can decompile but not webFetch', () => {
    expect(checkVisibility(DEFAULT_VISIBILITY, 'reverse', 'decompile').allowed).toBe(true)
    expect(checkVisibility(DEFAULT_VISIBILITY, 'reverse', 'webFetch').allowed).toBe(false)
  })

  it('default visibility: universal tools work in any role', () => {
    expect(checkVisibility(DEFAULT_VISIBILITY, 'web', 'runCommand').allowed).toBe(true)
    expect(checkVisibility(DEFAULT_VISIBILITY, 'crypto', 'runCommand').allowed).toBe(true)
  })

  it('denied reason includes role and toolId', () => {
    const r = checkVisibility(DEFAULT_VISIBILITY, 'web', 'gdb')
    expect(r.allowed).toBe(false)
    expect(r.reason).toBe('role_denied')
    expect(r.role).toBe('web')
    expect(r.toolId).toBe('gdb')
  })
})
