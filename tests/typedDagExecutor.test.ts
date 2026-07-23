/**
 * Phase 2.1 — Typed DAG executor + retry tests.
 */

import { describe, it, expect } from 'vitest'
import {
  runTypedDag,
  validateTypedDag,
  TypedDagCycleError,
  TypedDagValidationError,
  type TypedDagRunContext,
  type TypedStepRunner,
  type TypedStepOutcome,
} from '../src/core/typedDagExecutor.js'
import type { TypedWorkflowDefinition } from '../src/core/workflowDefinition.js'
import { UNKNOWN_FILE_TRIAGE_TYPED } from '../src/workflows/typed/unknownFileTriage.js'
import { IMAGE_QUICK_SCAN_TYPED } from '../src/workflows/typed/imageQuickScan.js'
import { ENCODING_SWEEP_TYPED } from '../src/workflows/typed/encodingSweep.js'
import type { CTFAttempt } from '../src/core/ctfRuntime/taskState.js'

function makeRunner(opts: {
  tools?: Record<string, () => Promise<{ content: string; isError: boolean; errorCode?: string; artifactIds: string[] }>>
  flakyUntil?: number
} = {}): { runner: TypedStepRunner; calls: Map<string, number> } {
  const calls = new Map<string, number>()
  const runner: TypedStepRunner = {
    async runTool(step, _ctx) {
      const k = `${step.id}@${step.toolId}`
      const n = (calls.get(k) ?? 0) + 1
      calls.set(k, n)
      const handler = opts.tools?.[step.toolId]
      if (handler) return handler()
      // Default: fail until flakyUntil is reached.
      if (opts.flakyUntil !== undefined && n < opts.flakyUntil) {
        return { content: `flaky-${n}`, isError: true, errorCode: 'temporary_error', artifactIds: [] }
      }
      return { content: `out-${step.id}`, isError: false, artifactIds: [] }
    },
    async runHandoff() { return { content: '', isError: false, artifactIds: [] } },
    async emitFinding() { return { observationIds: [], evidenceIds: [] } },
  }
  return { runner, calls }
}

function makeContext(overrides: Partial<TypedDagRunContext> = {}): TypedDagRunContext & { attempts: CTFAttempt[] } {
  const attempts: CTFAttempt[] = []
  const ctx: TypedDagRunContext & { attempts: CTFAttempt[] } = {
    taskId: 't1',
    workflowId: 'wf1',
    inputs: {},
    capturedOutputs: new Map(),
    issueAttemptId: () => `att_${attempts.length + 1}`,
    recordExecutions: (_attemptId, _stepId, _executions) => {
      // no-op for tests
    },
    attempts,
    ...overrides,
  }
  return ctx
}

describe('TypedDagExecutor — validation', () => {
  it('rejects duplicate step ids', () => {
    const wf: TypedWorkflowDefinition = {
      id: 'w', displayName: 'w', description: 'w', executionMode: 'dag', inputs: [],
      stopConditions: [], steps: [
        { id: 'a', kind: 'tool', toolId: 't', dependsOn: [], emit_finding: false },
        { id: 'a', kind: 'tool', toolId: 't', dependsOn: [], emit_finding: false },
      ],
    }
    expect(() => validateTypedDag(wf)).toThrow(TypedDagValidationError)
  })
  it('rejects missing dependsOn target', () => {
    const wf: TypedWorkflowDefinition = {
      id: 'w', displayName: 'w', description: 'w', executionMode: 'dag', inputs: [],
      stopConditions: [], steps: [
        { id: 'a', kind: 'tool', toolId: 't', dependsOn: ['missing'], emit_finding: false },
      ],
    }
    expect(() => validateTypedDag(wf)).toThrow(/unknown step missing/)
  })
  it('detects cycle', () => {
    const wf: TypedWorkflowDefinition = {
      id: 'w', displayName: 'w', description: 'w', executionMode: 'dag', inputs: [],
      stopConditions: [], steps: [
        { id: 'a', kind: 'tool', toolId: 't', dependsOn: ['b'], emit_finding: false },
        { id: 'b', kind: 'tool', toolId: 't', dependsOn: ['a'], emit_finding: false },
      ],
    }
    expect(() => validateTypedDag(wf)).toThrow(TypedDagCycleError)
  })
})

describe('TypedDagExecutor — execution', () => {
  it('runs independent steps in parallel', async () => {
    const wf: TypedWorkflowDefinition = {
      id: 'w', displayName: 'w', description: 'w', executionMode: 'dag', inputs: [],
      stopConditions: [], steps: [
        { id: 'a', kind: 'tool', toolId: 't1', dependsOn: [], emit_finding: false },
        { id: 'b', kind: 'tool', toolId: 't2', dependsOn: [], emit_finding: false },
      ],
    }
    const { runner, calls } = makeRunner()
    const ctx = makeContext()
    const r = await runTypedDag(wf, ctx, runner)
    expect(r.status).toBe('success')
    expect(r.stepOutcomes.length).toBe(2)
    expect(calls.size).toBeGreaterThanOrEqual(2)
  })

  it('respects dependsOn ordering', async () => {
    const wf: TypedWorkflowDefinition = {
      id: 'w', displayName: 'w', description: 'w', executionMode: 'dag', inputs: [],
      stopConditions: [], steps: [
        { id: 'a', kind: 'tool', toolId: 't', dependsOn: [], emit_finding: false },
        { id: 'b', kind: 'tool', toolId: 't', dependsOn: ['a'], emit_finding: false },
      ],
    }
    const { runner, calls } = makeRunner()
    const ctx = makeContext()
    const r = await runTypedDag(wf, ctx, runner)
    expect(r.status).toBe('success')
    // 'a' should be recorded before 'b' in stepOutcomes (parallel wave
    // but b depends on a so a runs first; order is by wave).
    const order = r.stepOutcomes.map((o: TypedStepOutcome) => o.stepId)
    expect(order[0]).toBe('a')
  })

  it('stops on matched stop condition', async () => {
    const wf: TypedWorkflowDefinition = {
      id: 'w', displayName: 'w', description: 'w', executionMode: 'dag', inputs: [],
      stopConditions: [{ type: 'step_succeeded', stepId: 'a' }],
      steps: [
        { id: 'a', kind: 'tool', toolId: 't', dependsOn: [], emit_finding: false },
        { id: 'b', kind: 'tool', toolId: 't', dependsOn: [], emit_finding: false },
        { id: 'c', kind: 'tool', toolId: 't', dependsOn: [], emit_finding: false },
      ],
    }
    const { runner } = makeRunner()
    const ctx = makeContext()
    const r = await runTypedDag(wf, ctx, runner)
    expect(r.stoppedEarly).toBe(true)
    expect(r.matchedStopCondition?.type).toBe('step_succeeded')
  })

  it('dependency failure skip policy prevents descendants', async () => {
    const wf: TypedWorkflowDefinition = {
      id: 'w', displayName: 'w', description: 'w', executionMode: 'dag', inputs: [],
      stopConditions: [], steps: [
        { id: 'a', kind: 'tool', toolId: 'fail', dependsOn: [], emit_finding: false, retry: { maxAttempts: 1, retryOn: [] } },
        { id: 'b', kind: 'tool', toolId: 't', dependsOn: ['a'], emit_finding: false },
        { id: 'c', kind: 'tool', toolId: 't', dependsOn: ['b'], emit_finding: false },
      ],
    }
    const { runner } = makeRunner({
      tools: {
        fail: async () => ({ content: 'broken', isError: true, artifactIds: [] }),
        t: async () => ({ content: 'ok', isError: false, artifactIds: [] }),
      },
    })
    const ctx = makeContext({ dependencyFailurePolicy: 'skip' })
    const r = await runTypedDag(wf, ctx, runner)
    // 'a' failed; b and c are descendants that never ran.
    expect(r.status).toBe('failed')
    // b + c are never dispatched, so no outcome is recorded.
    const skippedOrMissing = r.stepOutcomes.filter((o) => o.stepId === 'b' || o.stepId === 'c')
    expect(skippedOrMissing.length).toBe(0)
  })
})

describe('TypedDagExecutor — retry', () => {
  it('retries on temporary_error up to maxAttempts', async () => {
    const wf: TypedWorkflowDefinition = {
      id: 'w', displayName: 'w', description: 'w', executionMode: 'dag', inputs: [],
      stopConditions: [], steps: [
        { id: 'a', kind: 'tool', toolId: 't', dependsOn: [], emit_finding: false, retry: { maxAttempts: 3, backoffMs: 10, backoffMultiplier: 1, retryOn: ['temporary_error'] } },
      ],
    }
    const { runner, calls } = makeRunner({ flakyUntil: 3 })
    const ctx = makeContext()
    const r = await runTypedDag(wf, ctx, runner)
    expect(r.status).toBe('success')
    // The same tool + step key is reused — first call fails, second succeeds
    // by the time we hit call #2.
    const toolCalls = calls.get('a@t') ?? 0
    expect(toolCalls).toBeGreaterThanOrEqual(2)
  })

  it('caps at maxAttempts and surfaces error', async () => {
    const wf: TypedWorkflowDefinition = {
      id: 'w', displayName: 'w', description: 'w', executionMode: 'dag', inputs: [],
      stopConditions: [], steps: [
        { id: 'a', kind: 'tool', toolId: 't', dependsOn: [], emit_finding: false, retry: { maxAttempts: 3, backoffMs: 5, backoffMultiplier: 1, retryOn: ['temporary_error'] } },
      ],
    }
    const { runner, calls } = makeRunner({ flakyUntil: 99 })
    const ctx = makeContext()
    const r = await runTypedDag(wf, ctx, runner)
    expect(r.status).toBe('failed')
    expect(calls.get('a@t')).toBe(3)
  })

  it('does not retry on success', async () => {
    const wf: TypedWorkflowDefinition = {
      id: 'w', displayName: 'w', description: 'w', executionMode: 'dag', inputs: [],
      stopConditions: [], steps: [
        { id: 'a', kind: 'tool', toolId: 't', dependsOn: [], emit_finding: false, retry: { maxAttempts: 5, backoffMs: 5, retryOn: ['temporary_error'] } },
      ],
    }
    const { runner, calls } = makeRunner()
    const ctx = makeContext()
    const r = await runTypedDag(wf, ctx, runner)
    expect(r.status).toBe('success')
    expect(calls.get('a@t')).toBe(1)
  })

  it('records multiple AttemptExecution for the same attemptId', async () => {
    const wf: TypedWorkflowDefinition = {
      id: 'w', displayName: 'w', description: 'w', executionMode: 'dag', inputs: [],
      stopConditions: [], steps: [
        { id: 'a', kind: 'tool', toolId: 't', dependsOn: [], emit_finding: false, retry: { maxAttempts: 3, backoffMs: 5, retryOn: ['temporary_error'] } },
      ],
    }
    const recorded: Array<{ attemptId: string; stepId: string; count: number }> = []
    const { runner } = makeRunner({ flakyUntil: 3 })
    const ctx = makeContext({
      recordExecutions: (attemptId, stepId, executions) => {
        recorded.push({ attemptId, stepId, count: executions.length })
      },
    })
    await runTypedDag(wf, ctx, runner)
    const a = recorded.find((r) => r.stepId === 'a')
    expect(a).toBeDefined()
    expect(a!.count).toBeGreaterThanOrEqual(2)
    // The same attemptId is used across executions.
    expect(a!.attemptId).toMatch(/^att_/)
  })
})

describe('TypedDagExecutor — three migrated workflows', () => {
  it('runs unknown_file_triage DAG end-to-end', async () => {
    const { runner } = makeRunner({
      tools: {
        file: async () => ({ content: 'PNG image', isError: false, artifactIds: [] }),
        hex_header: async () => ({ content: '', isError: false, artifactIds: [] }),
        strings: async () => ({ content: '', isError: false, artifactIds: [] }),
        entropy: async () => ({ content: '', isError: false, artifactIds: [] }),
        'classify-by-type': async () => ({ content: 'ok', isError: false, artifactIds: [] }),
        'classify-unknown': async () => ({ content: 'ok', isError: false, artifactIds: [] }),
      },
    })
    const ctx = makeContext()
    const r = await runTypedDag(UNKNOWN_FILE_TRIAGE_TYPED, ctx, runner)
    expect(['success', 'partial']).toContain(r.status)
    expect(r.stepOutcomes.length).toBeGreaterThan(0)
  })

  it('runs image_quick_scan DAG end-to-end', async () => {
    const { runner } = makeRunner({
      tools: {
        file: async () => ({ content: '', isError: false, artifactIds: [] }),
        exiftool: async () => ({ content: '', isError: false, artifactIds: [] }),
        strings: async () => ({ content: '', isError: false, artifactIds: [] }),
        binwalk: async () => ({ content: '', isError: false, artifactIds: [] }),
        zsteg: async () => ({ content: '', isError: false, artifactIds: [] }),
        'materialize-image': async () => ({ content: '', isError: false, artifactIds: [] }),
      },
    })
    const ctx = makeContext()
    const r = await runTypedDag(IMAGE_QUICK_SCAN_TYPED, ctx, runner)
    expect(['success', 'partial']).toContain(r.status)
  })

  it('runs encoding_sweep DAG end-to-end', async () => {
    const { runner } = makeRunner({
      tools: {
        'encoding-detect': async () => ({ content: 'base64', isError: false, artifactIds: [] }),
        'decode-tree': async () => ({ content: '', isError: false, artifactIds: [] }),
        'extract-candidates': async () => ({ content: '', isError: false, artifactIds: [] }),
      },
    })
    const ctx = makeContext()
    const r = await runTypedDag(ENCODING_SWEEP_TYPED, ctx, runner)
    expect(['success', 'partial']).toContain(r.status)
  })

  it('empty workflow returns success (round-5 audit fix)', async () => {
    const wf: TypedWorkflowDefinition = {
      id: 'empty', displayName: 'empty', description: 'empty', executionMode: 'dag', inputs: [],
      stopConditions: [], steps: [],
    }
    const { runner } = makeRunner()
    const ctx = makeContext()
    const r = await runTypedDag(wf, ctx, runner)
    expect(r.status).toBe('success')
    expect(r.stepOutcomes.length).toBe(0)
    expect(r.stoppedEarly).toBe(false)
  })

  it('if step with non-empty then/else executes branch', async () => {
    let toolCalls = 0
    const { runner } = makeRunner({
      tools: {
        branch_tool: async () => {
          toolCalls++
          return { content: 'ok', isError: false, artifactIds: [] }
        },
      },
    })
    const wf: TypedWorkflowDefinition = {
      id: 'if-test', displayName: 'if', description: 'if', executionMode: 'dag', inputs: [],
      stopConditions: [],
      steps: [
        {
          id: 'pick',
          kind: 'if',
          condition: { type: 'artifact_exists' },
          then: [{ id: 'branch-tool-then', kind: 'tool', toolId: 'branch_tool', dependsOn: [], emit_finding: false }],
          else: [{ id: 'branch-tool-else', kind: 'tool', toolId: 'branch_tool', dependsOn: [], emit_finding: false }],
          dependsOn: [],
        },
      ],
    }
    const ctx = makeContext()
    const r = await runTypedDag(wf, ctx, runner)
    // Tool ran once (the else branch). Parent 'if' is recorded as succeeded.
    expect(toolCalls).toBe(1)
    expect(r.stepOutcomes.find((o) => o.stepId === 'pick')?.status).toBe('succeeded')
    expect(r.stepOutcomes.find((o) => o.stepId === 'pick:branch-tool-else')?.status).toBe('succeeded')
  })
})