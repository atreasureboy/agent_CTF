/**
 * Workflow Engine — sequential, parallel, conditional, emit_finding.
 */

import { describe, expect, it } from 'vitest'

import type { WorkflowRunner, RunContext } from '../src/core/workflowEngine.js'
import { WorkflowEngine } from '../src/core/workflowEngine.js'
import { WorkflowRegistry } from '../src/core/workflowRegistry.js'
import { BUILTIN_WORKFLOWS } from '../src/workflows/builtins.js'
import {
  ensureWorkflowsRegistered,
  __resetWorkflowRegistrationForTests,
} from '../src/workflows/index.js'
import type { WorkflowDefinition } from '../src/core/workflowDefinition.js'

function buildMockRunner(behaviors: Record<string, () => string>): WorkflowRunner {
  return {
    runStep(step, _ctx) {
      if (step.kind !== 'tool' && step.kind !== 'shell') return Promise.resolve({ content: '', isError: false, artifactIds: [] })
      const fp = step.kind === 'tool' ? `${step.toolId}::${step.id}` : `shell::${step.id}`
      const fn = behaviors[fp] ?? behaviors[step.id]
      const content = fn ? fn() : `mock-output-${step.id}`
      return Promise.resolve({ content, isError: false, artifactIds: [`art_${step.id}`] })
    },
    emitFinding(_step, _ctx) {
      return Promise.resolve()
    },
  }
}

describe('WorkflowEngine', () => {
  it('runs a sequential workflow and aggregates outputs', async () => {
    const def: WorkflowDefinition = {
      id: 'unit-seq',
      name: 'unit seq',
      description: '',
      domains: [],
      acceptedInputs: [],
      steps: [
        { id: 'a', kind: 'tool', toolId: 'Bash', input: {} },
        { id: 'b', kind: 'tool', toolId: 'Bash', input: {} },
      ],
      executionMode: 'sequential',
      requiredTools: [],
      stopConditions: [],
      partialFailurePolicy: 'continue',
    }
    const runner = buildMockRunner({
      a: () => 'AAAA',
      b: () => 'BBBB',
    })
    const ctx: RunContext = { taskId: 't', agentId: 'a', workflowId: 'unit-seq', inputs: {}, capturedOutputs: new Map() }
    const engine = new WorkflowEngine(runner)
    const result = await engine.run(def, ctx)

    expect(result.status).toBe('success')
    expect(result.stepOutcomes.map((s) => s.stepId)).toEqual(['a', 'b'])
    expect(ctx.capturedOutputs.get('a')).toBe('AAAA')
    expect(ctx.capturedOutputs.get('b')).toBe('BBBB')
    expect(result.emittedArtifactCount).toBe(2)
  })

  it('runs a parallel workflow and joins with all', async () => {
    const def: WorkflowDefinition = {
      id: 'unit-par',
      name: 'unit par',
      description: '',
      domains: [],
      acceptedInputs: [],
      steps: [
        {
          id: 'p',
          kind: 'parallel',
          join: 'all',
          steps: [
            { id: 'p1', kind: 'tool', toolId: 'Bash', input: {} },
            { id: 'p2', kind: 'tool', toolId: 'Bash', input: {} },
          ],
        },
      ],
      executionMode: 'parallel',
      requiredTools: [],
      stopConditions: [],
      partialFailurePolicy: 'continue',
    }
    const runner = buildMockRunner({})
    const ctx: RunContext = { taskId: 't', agentId: 'a', workflowId: 'unit-par', inputs: {}, capturedOutputs: new Map() }
    const engine = new WorkflowEngine(runner)
    const result = await engine.run(def, ctx)
    expect(result.status).toBe('success')
    // Parallel wrappers don't push their own outcome — only the inner steps do.
    expect(result.stepOutcomes.map((s) => s.stepId).sort()).toEqual(['p1', 'p2'])
  })

  it('evaluates an if condition against captured outputs', async () => {
    const def: WorkflowDefinition = {
      id: 'unit-if',
      name: 'unit if',
      description: '',
      domains: [],
      acceptedInputs: [],
      steps: [
        { id: 'capture', kind: 'tool', toolId: 'Bash', input: {} },
        {
          id: 'cond',
          kind: 'if',
          when: 'capture.length > 0',
          then: [{ id: 'after', kind: 'tool', toolId: 'Bash', input: {} }],
        },
      ],
      executionMode: 'sequential',
      requiredTools: [],
      stopConditions: [],
      partialFailurePolicy: 'continue',
    }
    const runner = buildMockRunner({ capture: () => 'hello' })
    const ctx: RunContext = { taskId: 't', agentId: 'a', workflowId: 'unit-if', inputs: {}, capturedOutputs: new Map() }
    const engine = new WorkflowEngine(runner)
    const result = await engine.run(def, ctx)
    const ids = result.stepOutcomes.map((s) => s.stepId)
    expect(ids).toContain('after')
  })

  it('emits findings through the runner', async () => {
    const def: WorkflowDefinition = {
      id: 'unit-find',
      name: 'unit find',
      description: '',
      domains: [],
      acceptedInputs: [],
      steps: [
        {
          id: 'f',
          kind: 'emit_finding',
          category: 'triage',
          title: 'T',
          summary: 'S',
          confidence: 'high',
        },
      ],
      executionMode: 'sequential',
      requiredTools: [],
      stopConditions: [],
      partialFailurePolicy: 'continue',
    }
    let emitted = 0
    const runner: WorkflowRunner = {
      runStep() { return Promise.resolve({ content: 'ok', isError: false, artifactIds: [] }) },
      emitFinding(_step, _ctx) { emitted++; return Promise.resolve() },
    }
    const result = await new WorkflowEngine(runner).run(def, { taskId: 't', agentId: 'a', workflowId: 'unit-find', inputs: {}, capturedOutputs: new Map() })
    expect(result.emittedFindingCount).toBe(1)
    expect(emitted).toBe(1)
  })
})

describe('WorkflowRegistry', () => {
  it('registers and lists built-in workflows', () => {
    __resetWorkflowRegistrationForTests()
    const reg = new WorkflowRegistry()
    ensureWorkflowsRegistered(reg)
    expect(reg.has('unknown_file_triage')).toBe(true)
    expect(reg.has('image_quick_scan')).toBe(true)
    expect(reg.has('encoding_sweep')).toBe(true)
    expect(reg.has('rsa_common_attacks')).toBe(true)
    expect(reg.list().length).toBe(BUILTIN_WORKFLOWS.length)
  })

  it('does not duplicate ids on re-register', () => {
    __resetWorkflowRegistrationForTests()
    const reg = new WorkflowRegistry()
    ensureWorkflowsRegistered(reg)
    ensureWorkflowsRegistered(reg)
    expect(reg.list().length).toBe(BUILTIN_WORKFLOWS.length)
  })

  it('filters by profile', () => {
    __resetWorkflowRegistrationForTests()
    const reg = new WorkflowRegistry()
    ensureWorkflowsRegistered(reg)
    const image = {
      id: 'image-stego',
      displayName: '',
      systemPromptModules: [],
      allowedWorkflows: ['image_quick_scan'],
      deniedWorkflows: ['rsa_common_attacks'],
      allowShell: true,
      allowPython: false,
      allowBackgroundJobs: true,
      allowAgentHandoff: true,
    }
    const visible = reg.listVisible(image)
    expect(visible.map((w) => w.id)).toContain('image_quick_scan')
    expect(visible.map((w) => w.id)).not.toContain('rsa_common_attacks')
  })
})
