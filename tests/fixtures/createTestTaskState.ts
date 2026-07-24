/**
 * Test fixture helpers — Phase 2.2 §十八.
 *
 * Tests that previously constructed a CTFTaskState literal will fail
 * to compile (the new fields are mandatory). This helper provides a
 * canonical "blank" state that fills in the new fields with defaults.
 */

import type { CTFTaskState } from '../../src/core/ctfRuntime/taskState.js'
import {
  createInitialReasoningBudgetState,
  DEFAULT_REASONING_BUDGET_LIMITS,
} from '../../src/core/ctfReasoning/reasoningBudget.js'

export function createTestTaskState(overrides: Partial<CTFTaskState> = {}): CTFTaskState {
  const taskId = overrides.taskId ?? 'test-task'
  const base: CTFTaskState = {
    taskId,
    phase: 'triage',
    context: {
      taskId,
      workspaceDir: '/tmp/test',
      sessionDir: '/tmp/test/s',
      artifactDir: '/tmp/test/a',
      inputDir: '/tmp/test/i',
      eventsFile: '/tmp/test/e.ndjson',
      profileId: 'triage',
      contestScope: { allowedFilesRoot: '/tmp/test', allowPublicNetwork: false, allowHeavyOneShots: false },
      contestConfig: { allowedFilesRoot: '/tmp/test', allowPublicNetwork: false, allowHeavyOneShots: false },
      environment: {},
      abortSignal: new AbortController().signal,
      metadata: {},
    },
    challenge: { inputArtifactIds: [] },
    activeProfileId: 'triage',
    findings: [],
    artifactIds: [],
    hypotheses: [],
    attempts: [],
    handoffs: [],
    agentRuns: [],
    workflowRuns: [],
    jobs: [],
    oneShotRuns: [],
    activeAgentRunIds: [],
    activeWorkflowRunIds: [],
    activeJobIds: [],
    observations: [],
    evidence: [],
    strategyDecisions: [],
    pendingActions: [],
    reasoningBudget: createInitialReasoningBudgetState(),
    reasoningBudgetLimits: DEFAULT_REASONING_BUDGET_LIMITS,
    flagCandidates: [],
    diagnostics: [],
    degraded: false,
    createdAt: 0,
    updatedAt: 0,
  }
  return { ...base, ...overrides, context: { ...base.context, ...(overrides.context ?? {}) } }
}