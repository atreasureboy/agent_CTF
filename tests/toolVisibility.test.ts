import { describe, expect, it } from 'vitest'
import { MCPVisibilityRegistry, ToolVisibilityPolicy } from '../src/core/toolVisibility/index.js'

describe('ToolVisibilityPolicy & MCPVisibility', () => {
  it('restricts Orchestrator to high-level orchestrator tools only', () => {
    const policy = new ToolVisibilityPolicy()
    const tools = [
      { name: 'inspect_task_state' },
      { name: 'run_workflow' },
      { name: 'exiftool' },
      { name: 'binwalk' },
    ]

    const filtered = policy.filterVisibleTools(tools, { isOrchestrator: true })
    expect(filtered.map((t) => t.name)).toEqual(['inspect_task_state', 'run_workflow'])
    expect(filtered.map((t) => t.name)).not.toContain('binwalk')
  })

  it('limits visible tools for auxiliary models (maxVisibleTools)', () => {
    const policy = new ToolVisibilityPolicy()
    const tools = Array.from({ length: 25 }, (_, i) => ({ name: `tool_${i}` }))

    const filtered = policy.filterVisibleTools(tools, {
      isOrchestrator: false,
      maxVisibleTools: 10,
    })
    expect(filtered.length).toBe(10)
  })

  it('hides MCP browser tools from orchestrator and exposes only to browser specialist', () => {
    const policy = new ToolVisibilityPolicy()
    const mcpRegistry = new MCPVisibilityRegistry(policy)

    mcpRegistry.registerServer({
      name: 'browser_mcp',
      command: 'node',
      visibility: ['specialist:web/browser'],
      exposeToolsToParent: false,
    })

    mcpRegistry.applyMCPServerVisibility('browser_mcp', ['click_element', 'type_input'])

    const isVisibleToOrchestrator = policy.isToolVisible('click_element', { isOrchestrator: true })
    expect(isVisibleToOrchestrator).toBe(false)

    const isVisibleToSpecialist = policy.isToolVisible('click_element', {
      specialistId: 'web/browser',
    })
    expect(isVisibleToSpecialist).toBe(true)
  })
})
