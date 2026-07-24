/**
 * Phase F — Structured-output action schema validation.
 */

import { describe, it, expect } from 'vitest'
import { validateAction, formatValidationErrors } from '../src/core/ctfReasoning/actionSchema.js'

describe('ActionSchema (F)', () => {
  it('accepts a valid run_workflow action', () => {
    const r = validateAction({
      type: 'run_workflow',
      workflowId: 'image_quick_scan',
      inputs: { file: '/tmp/x' },
      reason: 'scan the dropped image',
      priority: 5,
      costTier: 'cheap',
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.type).toBe('run_workflow')
      expect(r.value.workflowId).toBe('image_quick_scan')
    }
  })

  it('rejects missing workflowId', () => {
    const r = validateAction({
      type: 'run_workflow',
      inputs: {},
      reason: 'r',
      priority: 1,
      costTier: 'cheap',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.errors.find((e) => e.path === '$.workflowId')).toBeDefined()
    }
  })

  it('rejects out-of-range priority', () => {
    const r = validateAction({
      type: 'call_tool',
      toolId: 'file',
      input: {},
      reason: 'r',
      priority: 999,
      costTier: 'cheap',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.errors.find((e) => e.path === '$.priority')).toBeDefined()
    }
  })

  it('rejects unknown action type', () => {
    const r = validateAction({ type: 'fly_to_mars', reason: 'r', priority: 1, costTier: 'cheap' })
    expect(r.ok).toBe(false)
  })

  it('rejects non-object input', () => {
    const r = validateAction({ type: 'call_tool', toolId: 'x', input: 'not-an-object', reason: 'r', priority: 1, costTier: 'cheap' })
    expect(r.ok).toBe(false)
  })

  it('accepts a valid verify_flag with hypothesisIds', () => {
    const r = validateAction({
      type: 'verify_flag',
      candidateId: 'c1',
      reason: 'try',
      priority: 9,
      costTier: 'cheap',
      hypothesisIds: ['h1', 'h2'],
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.hypothesisIds).toEqual(['h1', 'h2'])
  })

  it('accepts request_handoff with all required fields', () => {
    const r = validateAction({
      type: 'request_handoff',
      capability: 'reverse',
      objective: 'analyse the binary',
      artifactIds: ['art1'],
      reason: 'needs reverse engineering',
      priority: 5,
      costTier: 'normal',
    })
    expect(r.ok).toBe(true)
  })

  it('formatValidationErrors produces a string', () => {
    const s = formatValidationErrors([
      { path: '$.a', message: 'required' },
      { path: '$.b', message: 'must be number' },
    ])
    expect(s).toBe('$.a: required; $.b: must be number')
  })

  it('accepts run_oneshot with options', () => {
    const r = validateAction({
      type: 'run_oneshot',
      manifestId: 'm1',
      inputArtifactIds: ['art1', 'art2'],
      options: { timeout: 30 },
      reason: 'r',
      priority: 5,
      costTier: 'normal',
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.options).toEqual({ timeout: 30 })
  })
})
