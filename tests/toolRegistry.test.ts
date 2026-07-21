/**
 * ToolRegistry — register / list / resolveFor + availability check.
 */

import { describe, expect, it } from 'vitest'

import { ToolRegistry } from '../src/core/toolRegistry.js'
import { TOOL_METADATA } from '../src/core/toolMetadata.js'
import { createTools } from '../src/tools/index.js'
import { PROFILES } from '../src/capabilityProfiles/builtin.js'

function buildRegistry(): ToolRegistry {
  return ToolRegistry.fromLegacyTools(createTools([]), TOOL_METADATA)
}

describe('ToolRegistry', () => {
  it('registers every legacy tool with metadata', () => {
    const r = buildRegistry()
    expect(r.has('Bash')).toBe(true)
    expect(r.has('Read')).toBe(true)
    expect(r.has('Agent')).toBe(true)
    expect(r.list().length).toBeGreaterThanOrEqual(11)
  })

  it('attaches domain metadata to Bash', () => {
    const r = buildRegistry()
    const bash = r.get('Bash')!
    expect(bash.domains).toContain('shell')
    expect(bash.executionMode).toBe('either')
    expect(bash.costClass).toBe('medium')
    expect(bash.outputMode).toBe('inline')
    expect(bash.riskLevel).toBe('medium')
  })

  it('lists tools by domain', () => {
    const r = buildRegistry()
    const web = r.listByDomain('web')
    expect(web.map((t) => t.id)).toEqual(expect.arrayContaining(['WebFetch', 'WebSearch']))
  })

  it('resolveFor filters by capability profile', () => {
    const r = buildRegistry()
    const image = PROFILES['image-stego']
    const visible = r.resolveFor(image)
    expect(visible.map((t) => t.name)).toEqual(
      expect.arrayContaining(['Bash', 'Read']),
    )
    // Image profile includes Bash but not everything; visible length should be smaller than total.
    expect(visible.length).toBeLessThan(r.list().length)
  })

  it('OpenAI tool definitions respect the profile filter', () => {
    const r = buildRegistry()
    const orchestrator = PROFILES['orchestrator']
    const defs = r.getOpenAIToolDefinitions(orchestrator)
    const names = defs.map((d) => d.function.name)
    // Orchestrator denies Bash
    expect(names).not.toContain('Bash')
    expect(names).not.toContain('Write')
    // Orchestrator allows Read
    expect(names).toContain('Read')
    // Orchestrator allows memory + meta tools
    expect(names).toContain('TodoWrite')
  })

  it('availability check returns empty for tools without required binaries', () => {
    const r = buildRegistry()
    const bash = r.get('Bash')!
    expect(ToolRegistry.checkAvailability(bash)).toEqual([])
  })
})
