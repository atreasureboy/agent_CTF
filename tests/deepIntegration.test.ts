import { describe, it, expect } from 'vitest'
import { ToolBroker } from '../src/core/toolBroker.js'
import { ToolRegistry } from '../src/core/toolRegistry.js'
import { PROFILES } from '../src/capabilityProfiles/builtin.js'
import { createAttemptDeduplicator } from '../src/core/ctfReasoning/attemptDeduplicator.js'
import { createAttemptFingerprint } from '../src/core/ctfReasoning/attemptFingerprint.js'
import { CTFTaskStateStore } from '../src/core/ctfRuntime/taskStateStore.js'
import { SpecialistContextCompiler } from '../src/core/contextCompiler/specialistContextCompiler.js'

function createBlankState(taskId: string): any {
  return {
    taskId,
    phase: 'created',
    activeProfileId: 'default',
    context: { taskId } as any,
    challenge: { inputArtifactIds: [] },
    findings: [],
    artifactIds: [],
    hypotheses: [],
    attempts: [],
    handoffs: [],
    agentRuns: [],
    workflowRuns: [],
    jobs: [],
    solverRuns: [],
    oneShotRuns: [],
    observations: [],
    evidence: [],
    strategyDecisions: [],
    pendingActions: [],
    reasoningBudget: {} as any,
    reasoningBudgetLimits: {} as any,
    activeAgentRunIds: [],
    activeWorkflowRunIds: [],
    activeJobIds: [],
    activeSolverRunIds: [],
    flagCandidates: [],
    diagnostics: [],
    degraded: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

describe('Deep Integration Mechanisms (D-CIPHER / CAI / Cyber-Zero)', () => {
  describe('Mechanism C: ToolBroker Hard-Gated Anti-Stagnation Interceptor', () => {
    it('blocks duplicate identical tool calls when fingerprint matches failed attempts', async () => {
      const registry = new ToolRegistry()
      const toolImpl = {
        name: 'Read',
        definition: {
          type: 'function' as const,
          function: {
            name: 'Read',
            description: 'read file',
            parameters: { type: 'object', properties: {} },
          },
        },
        execute: () => Promise.resolve({ content: 'file content', isError: false }),
      }
      registry.register(toolImpl, {
        id: 'Read',
        domains: ['forensics'],
        executionMode: 'inline',
        costClass: 'fast',
        outputMode: 'raw',
      })

      const initial = createBlankState('task_dedup_test')
      const stateStore = new CTFTaskStateStore(initial)
      const attemptDedup = createAttemptDeduplicator()

      const broker = new ToolBroker({
        registry,
        profile: PROFILES['crypto'],
        taskStateStore: stateStore,
        attemptDeduplicator: attemptDedup,
      })

      const fp = createAttemptFingerprint({
        kind: 'tool',
        targetId: 'Read',
        parameters: { path: 'secret.txt' },
      })
      // Add a failed attempt to stateStore via events
      stateStore.apply({
        type: 'ATTEMPT_STARTED',
        attempt: {
          id: 'attempt_1',
          kind: 'tool',
          targetId: 'Read',
          parameters: { path: 'secret.txt' },
          fingerprint: fp,
          status: 'running',
          startedAt: new Date().toISOString(),
          executions: [],
          observationIds: [],
          evidenceIds: [],
        },
      })
      stateStore.apply({
        type: 'ATTEMPT_FAILED',
        attemptId: 'attempt_1',
        error: 'failed to find flag',
        observationIds: [],
        evidenceIds: [],
      })

      // Try executing the exact same failed attempt
      const res = await broker.execute(
        'Read',
        { path: 'secret.txt' },
        { taskId: 'task_dedup_test', agentId: 'agent_1', cwd: '/tmp' },
      )

      expect(res.result.isError).toBe(true)
      expect(res.result.content).toContain(
        '[ToolBroker Guard] Action execution blocked due to repetition',
      )
    })

    it('allows tool call when arguments change', async () => {
      const registry = new ToolRegistry()
      const toolImpl = {
        name: 'Read',
        definition: {
          type: 'function' as const,
          function: {
            name: 'Read',
            description: 'read file',
            parameters: { type: 'object', properties: {} },
          },
        },
        execute: () => Promise.resolve({ content: 'file content', isError: false }),
      }
      registry.register(toolImpl, {
        id: 'Read',
        domains: ['forensics'],
        executionMode: 'inline',
        costClass: 'fast',
        outputMode: 'raw',
      })

      const initial = createBlankState('task_dedup_test_2')
      const stateStore = new CTFTaskStateStore(initial)
      const attemptDedup = createAttemptDeduplicator()

      const broker = new ToolBroker({
        registry,
        profile: PROFILES['crypto'],
        taskStateStore: stateStore,
        attemptDeduplicator: attemptDedup,
      })

      stateStore.apply({
        type: 'ATTEMPT_STARTED',
        attempt: {
          id: 'attempt_1',
          kind: 'tool',
          targetId: 'Read',
          parameters: { path: 'secret.txt' },
          status: 'running',
          startedAt: new Date().toISOString(),
          executions: [],
          observationIds: [],
          evidenceIds: [],
        },
      })
      stateStore.apply({
        type: 'ATTEMPT_FAILED',
        attemptId: 'attempt_1',
        error: 'failed to find flag',
        observationIds: [],
        evidenceIds: [],
      })

      // Different path argument
      const res = await broker.execute(
        'Read',
        { path: 'other.txt' },
        { taskId: 'task_dedup_test_2', agentId: 'agent_1', cwd: '/tmp' },
      )

      expect(res.result.isError).toBe(false)
      expect(res.result.content).toBe('file content')
    })
  })

  describe('Mechanism B: Deterministic Domain Guidance Compiler', () => {
    it('compiles failed attempt fingerprints and domain strategy into Specialist brief', () => {
      const compiled = SpecialistContextCompiler.compileSpecialistContext(
        {
          taskId: 'task_spec_test',
          profileId: 'crypto',
          objective: 'Solve RSA challenge',
          scopeSummary: 'local',
          artifacts: [],
          evidences: [
            {
              id: 'ev_1',
              title: 'RSA Public Key Found',
              factSummary: 'e=65537, n=123456789',
              confirmed: true,
              confidence: 1.0,
            },
          ],
          hypotheses: [],
          attempts: [
            {
              id: 'att_failed_1',
              kind: 'tool_call',
              targetId: 'Python',
              parameters: { script: 'factor.py' },
              status: 'failed',
              outcome: 'failed',
              fingerprint: 'fp_12345',
            } as any,
          ],
          allowedToolIds: ['Read', 'Python'],
          state: createBlankState('task_spec_test'),
        },
        'crypto',
        'gpt-4o',
      )

      expect(compiled.renderedText).toContain('=== DOMAIN EVIDENCE & ARTIFACTS ===')
      expect(compiled.renderedText).toContain('Evidence [E:ev_1]: RSA Public Key Found')
      expect(compiled.renderedText).toContain('=== BLOCKED / FAILED ATTEMPTS (DO NOT REPEAT) ===')
      expect(compiled.renderedText).toContain('att_failed_1')
      expect(compiled.renderedText).toContain('=== DOMAIN STRATEGY GUIDANCE ===')
    })
  })
})
