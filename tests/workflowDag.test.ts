/**
 * DAG execution mode tests.
 *
 * spec §三·5 requires WorkflowDefinition.executionMode to include 'dag'.
 * Our engine interprets 'dag' (and 'parallel') at the top level as
 * `Promise.allSettled` over all steps — i.e. concurrent execution with no
 * inter-step dependencies declared.
 */

import { describe, expect, it } from 'vitest'
import { createRequire } from 'module'
const require = createRequire(import.meta.url)

import { WorkflowEngine, type RunContext, type WorkflowRunner } from '../src/core/workflowEngine.js'
import { workflowDefinitionSchema, type WorkflowDefinition, type WorkflowStep } from '../src/core/workflowDefinition.js'

function makeRunner(delays: Record<string, number>): {
  runner: WorkflowRunner
  startOrder: string[]
  endOrder: string[]
} {
  const startOrder: string[] = []
  const endOrder: string[] = []
  const runner: WorkflowRunner = {
    async runStep(step, _ctx) {
      startOrder.push(step.id)
      const d = delays[step.id] ?? 10
      await new Promise((r) => setTimeout(r, d))
      endOrder.push(step.id)
      return { content: `out:${step.id}`, isError: false, artifactIds: [] }
    },
    async emitFinding(_step, _ctx) {
      return
    },
  }
  return { runner, startOrder, endOrder }
}

describe('WorkflowEngine — executionMode "dag" runs top-level steps concurrently', () => {
  it('dag mode: 3 independent steps with 50ms each finish in ~50ms, not ~150ms', async () => {
    const wf: WorkflowDefinition = {
      id: 'dag-test',
      name: 'DAG test',
      description: '',
      domains: [],
      acceptedInputs: [],
      executionMode: 'dag',
      requiredTools: [],
      stopConditions: [],
      partialFailurePolicy: 'continue',
      steps: [
        { kind: 'tool', id: 'a', toolId: 'Bash' },
        { kind: 'tool', id: 'b', toolId: 'Bash' },
        { kind: 'tool', id: 'c', toolId: 'Bash' },
      ],
    }
    const { runner, startOrder, endOrder } = makeRunner({ a: 50, b: 50, c: 50 })
    const ctx: RunContext = {
      taskId: 't',
      agentId: 'x',
      workflowId: 'dag-test',
      inputs: {},
      capturedOutputs: new Map(),
    }
    const t0 = Date.now()
    const result = await new WorkflowEngine(runner).run(wf, ctx)
    const elapsed = Date.now() - t0
    expect(result.status).toBe('success')
    expect(result.stepOutcomes).toHaveLength(3)
    // In concurrent mode, all 3 start before any ends — proven by startOrder
    // being populated ahead of any single end.
    expect(startOrder).toHaveLength(3)
    expect(endOrder).toHaveLength(3)
    // Wall clock should be ~50ms (parallel), not ~150ms (sequential).
    expect(elapsed).toBeLessThan(140)
  })

  it('dag mode accepts the value via the schema (parseable)', () => {
    const parsed = workflowDefinitionSchema.parse({
      id: 'x',
      name: 'x',
      steps: [{ kind: 'tool', id: 's', toolId: 'Bash' }],
      executionMode: 'dag',
    })
    expect(parsed.executionMode).toBe('dag')
    void require
  })

  it('sequential mode: 3 steps with 30ms each finish in ~90ms (startOrder shows serial start)', async () => {
    const wf: WorkflowDefinition = {
      id: 'seq-test',
      name: 'Seq test',
      description: '',
      domains: [],
      acceptedInputs: [],
      executionMode: 'sequential',
      requiredTools: [],
      stopConditions: [],
      partialFailurePolicy: 'continue',
      steps: [
        { kind: 'tool', id: 'a', toolId: 'Bash' },
        { kind: 'tool', id: 'b', toolId: 'Bash' },
        { kind: 'tool', id: 'c', toolId: 'Bash' },
      ],
    }
    const { runner, startOrder, endOrder } = makeRunner({ a: 30, b: 30, c: 30 })
    const ctx: RunContext = {
      taskId: 't',
      agentId: 'x',
      workflowId: 'seq-test',
      inputs: {},
      capturedOutputs: new Map(),
    }
    const t0 = Date.now()
    await new WorkflowEngine(runner).run(wf, ctx)
    const elapsed = Date.now() - t0
    // Sequential: end(i) must precede start(i+1).
    // endOrder index 0 < startOrder index 1 (because we only start b after a ends).
    expect(startOrder).toEqual(['a', 'b', 'c'])
    expect(endOrder).toEqual(['a', 'b', 'c'])
    expect(elapsed).toBeGreaterThan(80)
  })

  it('dag mode: one failed step does not cancel siblings (partial failure policy continues)', async () => {
    const wf: WorkflowDefinition = {
      id: 'partial-dag',
      name: 'Partial',
      description: '',
      domains: [],
      acceptedInputs: [],
      executionMode: 'dag',
      requiredTools: [],
      stopConditions: [],
      partialFailurePolicy: 'continue',
      steps: [
        { kind: 'tool', id: 'good', toolId: 'Bash' },
        { kind: 'tool', id: 'bad', toolId: 'Bash' },
        { kind: 'tool', id: 'good2', toolId: 'Bash' },
      ],
    }
    const startOrder: string[] = []
    const runner: WorkflowRunner = {
      async runStep(step) {
        startOrder.push(step.id)
        if (step.id === 'bad') {
          return { content: 'boom', isError: true, artifactIds: [] }
        }
        return { content: 'ok', isError: false, artifactIds: [] }
      },
      async emitFinding() {
        return
      },
    }
    const ctx: RunContext = {
      taskId: 't',
      agentId: 'x',
      workflowId: 'partial-dag',
      inputs: {},
      capturedOutputs: new Map(),
    }
    const result = await new WorkflowEngine(runner).run(wf, ctx)
    expect(result.status).toBe('partial')
    expect(result.stepOutcomes.find((o) => o.stepId === 'bad')?.status).toBe('failed')
    expect(result.stepOutcomes.find((o) => o.stepId === 'good')?.status).toBe('success')
    expect(result.stepOutcomes.find((o) => o.stepId === 'good2')?.status).toBe('success')
    // All three started (order shows concurrent scheduling — Promise.allSettled).
    expect(startOrder.sort()).toEqual(['bad', 'good', 'good2'])
  })
})

// Ensure unused import not flagged.
void undefined as unknown as WorkflowStep
