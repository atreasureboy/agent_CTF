import { describe, it, expect } from 'vitest'
import { createMockToolContext, okResult, errResult } from '../src/testing/index.js'

describe('createMockToolContext', () => {
  it('provides safe defaults for every field', () => {
    const ctx = createMockToolContext()
    expect(typeof ctx.cwd).toBe('string')
    expect(ctx.permissionMode).toBe('auto')
    expect(ctx.signal).toBeDefined()
    expect(typeof ctx.updateProgress).toBe('function')
    expect(ctx.apiConfig?.apiKey).toBe('test-key')
    expect(ctx.apiConfig?.model).toBe('test-model')
  })

  it('overrides take precedence', () => {
    const ctx = createMockToolContext({ cwd: '/custom', permissionMode: 'deny' })
    expect(ctx.cwd).toBe('/custom')
    expect(ctx.permissionMode).toBe('deny')
  })

  it('the signal is abortable (for tools that check cancellation)', () => {
    const ctx = createMockToolContext()
    expect(ctx.signal!.aborted).toBe(false)
  })
})

describe('result helpers', () => {
  it('okResult / errResult build the right shape', () => {
    expect(okResult('done')).toEqual({ content: 'done', isError: false })
    expect(errResult('nope')).toEqual({ content: 'nope', isError: true })
  })
})
