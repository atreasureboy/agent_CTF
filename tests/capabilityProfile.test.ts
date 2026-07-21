/**
 * CapabilityProfile — schema validation + allow/deny logic.
 */

import { describe, expect, it } from 'vitest'

import {
  capabilityProfileSchema,
  parseCapabilityProfile,
  profileAllowsTool,
  profileAllowsWorkflow,
  profileToolDenialReason,
} from '../src/core/capabilityProfile.js'

describe('capabilityProfile', () => {
  const minimal = {
    id: 'unit-test',
    displayName: 'Unit Test Agent',
    systemPromptModules: ['tool.first'],
    allowShell: false,
    allowPython: false,
    allowBackgroundJobs: true,
    allowAgentHandoff: true,
  }

  it('parses a minimal profile with defaults', () => {
    const p = parseCapabilityProfile(minimal)
    expect(p.id).toBe('unit-test')
    expect(p.systemPromptModules).toEqual(['tool.first'])
  })

  it('rejects overlap between allowed and denied workflows', () => {
    const r = capabilityProfileSchema.safeParse({
      ...minimal,
      allowedWorkflows: ['image_quick_scan'],
      deniedWorkflows: ['image_quick_scan'],
    })
    expect(r.success).toBe(false)
  })

  it('rejects overlap between allowed and denied commands', () => {
    const r = capabilityProfileSchema.safeParse({
      ...minimal,
      allowedCommands: ['nmap'],
      deniedCommands: ['nmap'],
    })
    expect(r.success).toBe(false)
  })

  it('enforces deny precedence over allow', () => {
    const p = parseCapabilityProfile({
      ...minimal,
      allowedTools: ['Bash'],
      deniedTools: ['Bash'],
    })
    expect(profileAllowsTool(p, 'Bash')).toBe(false)
  })

  it('allowlist restricts the available set', () => {
    const p = parseCapabilityProfile({
      ...minimal,
      allowedTools: ['Read', 'Glob'],
    })
    expect(profileAllowsTool(p, 'Read')).toBe(true)
    expect(profileAllowsTool(p, 'Bash')).toBe(false)
  })

  it('omitted allowlist = all permitted (subject to deny list)', () => {
    const p = parseCapabilityProfile({ ...minimal, deniedTools: ['Bash'] })
    expect(profileAllowsTool(p, 'Read')).toBe(true)
    expect(profileAllowsTool(p, 'Bash')).toBe(false)
  })

  it('denies workflows', () => {
    const p = parseCapabilityProfile({
      ...minimal,
      allowedWorkflows: ['image_quick_scan'],
    })
    expect(profileAllowsWorkflow(p, 'image_quick_scan')).toBe(true)
    expect(profileAllowsWorkflow(p, 'rsa_common_attacks')).toBe(false)
  })

  it('provides a structured denial reason string', () => {
    const p = parseCapabilityProfile({ ...minimal, deniedTools: ['Bash'] })
    expect(profileToolDenialReason(p, 'Bash')).toMatch(/denied by profile/)
  })

  it('returns null when no rule denies the tool', () => {
    const p = parseCapabilityProfile(minimal)
    expect(profileToolDenialReason(p, 'Read')).toBe(null)
  })
})
