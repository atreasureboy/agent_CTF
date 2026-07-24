/**
 * Phase C2 — ModelRegistry.
 */

import { describe, it, expect } from 'vitest'
import { ModelRegistry, RoundRobinSwap, backendId } from '../src/core/ctfReasoning/modelRegistry.js'

describe('ModelRegistry (C2)', () => {
  it('returns the default backend when no role is registered', () => {
    const r = new ModelRegistry({ defaultBackend: backendId('gpt-4o') })
    expect(r.lookup('orchestrator')).toBe('gpt-4o')
  })

  it('registers and looks up a role', () => {
    const r = new ModelRegistry({ defaultBackend: backendId('gpt-4o') })
    r.register('orchestrator', { primary: backendId('claude-opus') })
    expect(r.lookup('orchestrator')).toBe('claude-opus')
  })

  it('swapActiveBackend mid-task', () => {
    const r = new ModelRegistry({ defaultBackend: backendId('gpt-4o') })
    r.register('orchestrator', { primary: backendId('claude-opus'), secondary: backendId('claude-sonnet') })
    r.setActiveBackend('orchestrator', backendId('claude-sonnet'))
    expect(r.lookup('orchestrator')).toBe('claude-sonnet')
  })

  it('fallback returns the secondary backend', () => {
    const r = new ModelRegistry({ defaultBackend: backendId('gpt-4o') })
    r.register('orchestrator', { primary: backendId('a'), secondary: backendId('b') })
    expect(r.fallback('orchestrator')).toBe('b')
    expect(r.fallback('orchestrator')).toBe('b') // doesn't consume
  })

  it('fallback returns undefined when no secondary', () => {
    const r = new ModelRegistry({ defaultBackend: backendId('gpt-4o') })
    r.register('orchestrator', { primary: backendId('a') })
    expect(r.fallback('orchestrator')).toBeUndefined()
  })

  it('roles() lists all registered roles', () => {
    const r = new ModelRegistry({ defaultBackend: backendId('gpt-4o') })
    r.register('a', { primary: backendId('1') })
    r.register('b', { primary: backendId('2') })
    r.register('c', { primary: backendId('3') })
    expect(r.roles().sort()).toEqual(['a', 'b', 'c'])
  })
})

describe('RoundRobinSwap', () => {
  it('swaps every N turns (default 2)', () => {
    const r = new RoundRobinSwap(2)
    expect(r.shouldSwap()).toBe(false)
    expect(r.shouldSwap()).toBe(true)
    expect(r.shouldSwap()).toBe(false)
    expect(r.shouldSwap()).toBe(true)
  })

  it('reset returns to the start', () => {
    const r = new RoundRobinSwap(2)
    r.shouldSwap(); r.shouldSwap()
    r.reset()
    expect(r.shouldSwap()).toBe(false)
  })
})
