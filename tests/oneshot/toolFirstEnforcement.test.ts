import { describe, it, expect } from 'vitest'
import { ToolFirstPolicy, evaluatePolicyGate } from '../../src/core/toolFirstPolicy.js'
import { safeParseCapabilityProfile } from '../../src/core/capabilityProfile.js'

const profile = safeParseCapabilityProfile({
  id: 'web',
  displayName: 'Web',
  allowShell: true,
  allowedTools: ['Bash'],
  allowedCommands: ['curl', 'wget'],
  deniedCommands: ['nmap'],
})

if (!profile) throw new Error('profile parse failed')

describe('ToolFirstPolicy gate', () => {
  it('advisory mode never blocks', () => {
    const verdict = evaluatePolicyGate({
      mode: 'advisory',
      toolId: 'Bash',
      input: { command: 'curl -L example.com' },
      profile,
      failedWorkflowIds: [],
    })
    expect(verdict).toEqual({ allowed: true })
  })

  it('require_reason demands an overrideReason', () => {
    const a = evaluatePolicyGate({
      mode: 'require_reason',
      toolId: 'Bash',
      input: { command: 'curl -L https://example.com for path scan' },
      profile,
      failedWorkflowIds: [],
    })
    expect(a).toEqual({ allowed: 'with-reason' })

    const b = evaluatePolicyGate({
      mode: 'require_reason',
      toolId: 'Bash',
      input: { command: 'curl -L https://example.com for path scan' },
      profile,
      failedWorkflowIds: [],
      overrideReason: 'web_triage exhausted',
    })
    expect(b).toEqual({ allowed: true })
  })

  it('enforced blocks when no failed workflow and no override', () => {
    const r = evaluatePolicyGate({
      mode: 'enforced',
      toolId: 'Bash',
      input: { command: 'curl -L https://example.com for path scan' },
      profile,
      failedWorkflowIds: [],
    })
    expect(r.allowed).toBe(false)
    if (r.allowed === false) expect(r.reason).toMatch(/enforced/)
  })

  it('enforced allows after a failed workflow is recorded', () => {
    const r = evaluatePolicyGate({
      mode: 'enforced',
      toolId: 'Bash',
      input: { command: 'curl -L example.com for path scan' },
      profile,
      failedWorkflowIds: ['web_triage'],
    })
    expect(r).toEqual({ allowed: true })
  })

  it('no rule fires for non-matching tool input', () => {
    const policy = new ToolFirstPolicy()
    const verdict = policy.advise('Read', { file_path: 'a.txt' }, profile)
    expect(verdict.rule).toBe('__none__')
  })

  it('image stego rule suggests image_quick_scan', () => {
    const policy = new ToolFirstPolicy()
    const verdict = policy.advise('Bash', { command: 'extract pixel data from .png' }, profile)
    expect(verdict.suggestedWorkflowId).toBe('image_quick_scan')
  })
})
