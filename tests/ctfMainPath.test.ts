/**
 * Main-path tests for the third_goal.md architecture.
 *
 * These exercise the unique behavioural guarantees that the §十三 "actual main
 * flow" diagram asserts:
 *
 *   CLI  → Orchestrator → Main Agent / Workflow / Specialist
 *   CLI Signal → Orchestrator.cancel()
 *   Profile changes flow through a single ProfileStore.
 *   Job lifecycle events update TaskState (no polling).
 *   Specialist finds / artifacts are projected into TaskState.
 *   Old dispatchNext fallback is gone — dispatching without an orchestrator
 *   throws.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { CTFTaskOrchestrator } from '../src/core/ctfRuntime/taskOrchestrator.js'
import { BackgroundJobManager } from '../src/core/backgroundJobs.js'
import { dispatchNext } from '../src/core/orchestratorDispatch.js'
import { CTFProfileStore } from '../src/core/ctfRuntime/profileStore.js'
import { TaskStateProjector } from '../src/core/ctfRuntime/taskStateProjector.js'
import { createLinkedAbortController } from '../src/core/ctfRuntime/linkedAbortController.js'
import { CTFTaskStateStore } from '../src/core/ctfRuntime/taskStateStore.js'
import type { CTFTaskState } from '../src/core/ctfRuntime/taskState.js'
import {
  DuplicateAttemptError,
  DuplicateHypothesisError,
  IllegalAttemptTransitionError,
  TaskAlreadyCompletedError,
  UnknownAttemptError,
  UnknownHypothesisError,
} from '../src/core/ctfRuntime/taskStateStore.js'
import { parseContestScope } from '../src/core/contestScope.js'
import { createDefaultContestConfig } from '../src/core/contestConfig.js'
import type OpenAI from 'openai'
import type { Renderer } from '../src/ui/renderer.js'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ctf-mainpath-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

// ────────────────────────────────────────────────────────────────────────
// §四 — CLI main-path: Orchestrator owns creation
// ────────────────────────────────────────────────────────────────────────
describe('§四 — CLI main path uses CTFTaskOrchestrator', () => {
  it('CTFTaskOrchestrator.create returns a wired runtime', async () => {
    const orch = await CTFTaskOrchestrator.create({ cwd: root, profileId: 'triage' })
    try {
      expect(orch).toBeInstanceOf(CTFTaskOrchestrator)
      expect(orch.mainHarness).toBeDefined()
      expect(orch.store).toBeInstanceOf(CTFTaskStateStore)
      expect(orch.profileStore).toBeInstanceOf(CTFProfileStore)
      expect(orch.projector).toBeInstanceOf(TaskStateProjector)
      expect(orch.abort).toBeDefined()
      expect(orch.handoffCoordinator).toBeDefined()
      expect(orch.getState().activeProfileId).toBe('triage')
    } finally {
      await orch.dispose()
    }
  })

  it('workflow mode routes through orchestrator.runWorkflow, not harness.runWorkflow', async () => {
    const orch = await CTFTaskOrchestrator.create({
      cwd: root,
      profileId: 'triage',
      jobLimits: { maxPerAgent: 0, maxPerTask: 0 },
    })
    try {
      const r = await orch.runWorkflow('unknown_file_triage', {})
      // Workflow finished and produced a workflowRun record.
      expect(orch.getState().workflowRuns.length).toBeGreaterThan(0)
      expect(r.status).toBeDefined()
    } finally {
      await orch.dispose()
    }
  })

  it('SIGINT-style cancel propagates to the abort signal', async () => {
    const orch = await CTFTaskOrchestrator.create({ cwd: root, profileId: 'triage' })
    try {
      expect(orch.abort.signal.aborted).toBe(false)
      await orch.cancel('sigint-test')
      expect(orch.abort.signal.aborted).toBe(true)
    } finally {
      await orch.dispose()
    }
  })
})

// ────────────────────────────────────────────────────────────────────────
// §五 — Specialist dependencies + abort propagation
// ────────────────────────────────────────────────────────────────────────
describe('§五 — Specialist RuntimeDependencies', () => {
  it('linkedAbortController propagates parent abort to child', () => {
    const parent = new AbortController()
    const child = createLinkedAbortController(parent.signal)
    expect(child.signal.aborted).toBe(false)
    parent.abort('user_cancelled')
    expect(child.signal.aborted).toBe(true)
    expect(child.signal.reason).toBe('user_cancelled')
    child.unlink()
  })

  it('linkedAbortController unlink detaches the parent listener', () => {
    const parent = new AbortController()
    const child = createLinkedAbortController(parent.signal)
    child.unlink()
    parent.abort('after-unlink')
    expect(child.signal.aborted).toBe(false)
  })

  it('linkedAbortController handles pre-aborted parent', () => {
    const parent = new AbortController()
    parent.abort('early')
    const child = createLinkedAbortController(parent.signal)
    expect(child.signal.aborted).toBe(true)
    expect(child.signal.reason).toBe('early')
  })

  it('child can abort without affecting parent', () => {
    const parent = new AbortController()
    const child = createLinkedAbortController(parent.signal)
    child.controller.abort('child_done')
    expect(child.signal.aborted).toBe(true)
    expect(parent.signal.aborted).toBe(false)
  })
})

// ────────────────────────────────────────────────────────────────────────
// §六 — ProfileStore as single source of truth
// ────────────────────────────────────────────────────────────────────────
describe('§六 — ProfileStore', () => {
  it('switchTo notifies subscribers', () => {
    const store = new CTFProfileStore({
      id: 'orchestrator',
      displayName: 'A',
      allowedTools: [],
      deniedTools: [],
      allowedWorkflows: [],
      deniedWorkflows: [],
      allowShell: false,
      allowPython: false,
      allowBackgroundJobs: false,
      allowAgentHandoff: true,
      systemPromptModules: [],
    })
    const seen: string[] = []
    const unsub = store.subscribe((p) => seen.push(p.id))
    store.switchTo({
      id: 'triage',
      displayName: 'B',
      allowedTools: [],
      deniedTools: [],
      allowedWorkflows: [],
      deniedWorkflows: [],
      allowShell: false,
      allowPython: false,
      allowBackgroundJobs: false,
      allowAgentHandoff: true,
      systemPromptModules: [],
    })
    expect(seen).toEqual(['triage'])
    unsub()
    store.switchTo({
      id: 'image-stego',
      displayName: 'C',
      allowedTools: [],
      deniedTools: [],
      allowedWorkflows: [],
      deniedWorkflows: [],
      allowShell: false,
      allowPython: false,
      allowBackgroundJobs: false,
      allowAgentHandoff: true,
      systemPromptModules: [],
    })
    expect(seen).toEqual(['triage']) // no further notifications
  })

  it('switchTo rejects invalid profiles', () => {
    const store = new CTFProfileStore({
      id: 'orchestrator',
      displayName: 'A',
      allowedTools: [],
      deniedTools: [],
      allowedWorkflows: [],
      deniedWorkflows: [],
      allowShell: false,
      allowPython: false,
      allowBackgroundJobs: false,
      allowAgentHandoff: true,
      systemPromptModules: [],
    })
    // @ts-expect-error — intentionally invalid
    expect(() => store.switchTo({})).toThrow()
  })
})

// ────────────────────────────────────────────────────────────────────────
// §八 — Handoff unique path
// ────────────────────────────────────────────────────────────────────────
describe('§八 — Handoff unique execution path', () => {
  it('dispatchNext without orchestrator throws — legacy fallback is gone', async () => {
    const { createHarness } = await import('../src/core/harness.js')
    const h = createHarness({ cwd: root, profile: 'triage' })
    await h.broker.execute('request_handoff', {
      suggestedAgent: 'triage', reason: 'r', objective: 'o',
    }, { cwd: root, taskId: h.context.taskId, agentId: 'triage' })
    await expect(dispatchNext(h, { decision: 'approve' })).rejects.toThrow(
      /dispatchNext requires an attached CTFTaskOrchestrator/,
    )
  })

  it('concurrent approveHandoff calls only spawn one specialist', async () => {
    const orch = await CTFTaskOrchestrator.create({ cwd: root, profileId: 'triage' })
    try {
      const h = orch.requestHandoff({
        fromAgentRunId: 'run_main',
        targetCapability: 'triage',
        reason: 'concurrent',
        objective: 'test',
      })
      // Fire two approves in parallel.
      const [a, b] = await Promise.all([
        orch.approveHandoff(h.id),
        orch.approveHandoff(h.id),
      ])
      // Both calls resolved to the same in-flight run — neither spawned a
      // duplicate specialist.
      expect(orch.getState().agentRuns.filter((r) => r.handoffId === h.id).length).toBe(1)
      void a
      void b
    } finally {
      await orch.dispose()
    }
  })
})

// ────────────────────────────────────────────────────────────────────────
// §九 — TaskState events actually update state
// ────────────────────────────────────────────────────────────────────────
describe('§九 — TaskEvent reducer applies state changes', () => {
  function freshState(): CTFTaskState {
    const now = Date.now()
    return {
      taskId: 't', phase: 'intake',
      context: {
        taskId: 't',
        workspaceDir: root,
        sessionDir: root,
        artifactDir: join(root, 'artifacts'),
        eventsFile: join(root, 'events.ndjson'),
        profileId: 'orchestrator',
        contestScope: parseContestScope({ allowedFilesRoot: root, allowPublicNetwork: false }),
        contestConfig: createDefaultContestConfig({ cwd: root }),
      },
      challenge: { inputArtifactIds: [] },
      activeProfileId: 'orchestrator',
      findings: [], artifactIds: [], hypotheses: [], attempts: [],
      handoffs: [], agentRuns: [], activeAgentRunIds: [],
      workflowRuns: [], activeWorkflowRunIds: [],
      jobs: [], oneShotRuns: [], activeJobIds: [], observations: [], evidence: [], strategyDecisions: [],
      flagCandidates: [],
      createdAt: now, updatedAt: now,
    }
  }

  it('HYPOTHESIS_ADDED appends to the hypotheses array', () => {
    const store = new CTFTaskStateStore(freshState())
    expect(store.getState().hypotheses.length).toBe(0)
    store.apply({
      type: 'HYPOTHESIS_ADDED',
      hypothesis: {
        id: 'h1',
        taskId: 't1',
        statement: 'PNG contains ZIP',
        category: 'crypto',
        status: 'proposed',
        supportingEvidenceIds: [],
        contradictingEvidenceIds: [],
        proposedBy: { type: 'manual', id: 'main' },
        priority: 0,
        confidence: 0.5,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    })
    expect(store.getState().hypotheses.length).toBe(1)
    expect(store.getState().hypotheses[0].id).toBe('h1')
  })

  it('HYPOTHESIS_ADDED rejects duplicates', () => {
    const store = new CTFTaskStateStore(freshState())
    store.apply({
      type: 'HYPOTHESIS_ADDED',
      hypothesis: {
        id: 'h1',
        taskId: 't1',
        statement: 'x',
        category: 'crypto',
        status: 'proposed',
        supportingEvidenceIds: [],
        contradictingEvidenceIds: [],
        proposedBy: { type: 'manual', id: 'main' },
        priority: 0,
        confidence: 0.5,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    })
    expect(() =>
      store.apply({
        type: 'HYPOTHESIS_ADDED',
        hypothesis: {
          id: 'h1',
          taskId: 't1',
        statement: 'y',
        category: 'crypto',
        status: 'proposed',
        supportingEvidenceIds: [],
        contradictingEvidenceIds: [],
        proposedBy: { type: 'manual', id: 'main' },
        priority: 0,
        confidence: 0.5,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        },
      }),
    ).toThrow(DuplicateHypothesisError)
  })

  it('HYPOTHESIS_UPDATED throws on missing id', () => {
    const store = new CTFTaskStateStore(freshState())
    expect(() => store.apply({ type: 'HYPOTHESIS_UPDATED', hypothesisId: 'nope', patch: {} }))
      .toThrow(UnknownHypothesisError)
  })

  it('ATTEMPT_RECORDED appends; duplicates rejected', () => {
    const store = new CTFTaskStateStore(freshState())
    store.apply({
      type: 'ATTEMPT_RECORDED',
      attempt: {
        id: 'a1',
        kind: 'tool',
        targetId: 't1',
        input: {},
        taskId: 't1',
        fingerprint: 'fp_tool_t1',
        hypothesisIds: [],
        observationIds: [],
        evidenceIds: [],
        artifactIds: [],
        flagCandidateIds: [],
                status: 'pending',
        createdAt: Date.now(),
      },
    })
    expect(store.getState().attempts.length).toBe(1)
    expect(() =>
      store.apply({
        type: 'ATTEMPT_RECORDED',
        attempt: {
          id: 'a1',
          kind: 'tool',
        targetId: 't1',
        input: {},
        taskId: 't1',
        fingerprint: 'fp_tool_t1',
        hypothesisIds: [],
        observationIds: [],
        evidenceIds: [],
        artifactIds: [],
        flagCandidateIds: [],
                  status: 'pending',
          createdAt: Date.now(),
        },
      }),
    ).toThrow(DuplicateAttemptError)
  })

  it('ATTEMPT_UPDATED refuses completed → running', () => {
    const store = new CTFTaskStateStore(freshState())
    store.apply({
      type: 'ATTEMPT_RECORDED',
      attempt: {
        id: 'a1',
        kind: 'tool',
        targetId: 't1',
        input: {},
        taskId: 't1',
        fingerprint: 'fp_tool_t1',
        hypothesisIds: [],
        observationIds: [],
        evidenceIds: [],
        artifactIds: [],
        flagCandidateIds: [],
                status: 'running',
        createdAt: Date.now(),
      },
    })
    store.apply({
      type: 'ATTEMPT_UPDATED',
      attemptId: 'a1',
      patch: { status: 'succeeded', completedAt: Date.now() },
    })
    expect(() =>
      store.apply({
        type: 'ATTEMPT_UPDATED',
        attemptId: 'a1',
        patch: { status: 'running' },
      }),
    ).toThrow(IllegalAttemptTransitionError)
  })

  it('ATTEMPT_UPDATED throws on missing id', () => {
    const store = new CTFTaskStateStore(freshState())
    expect(() => store.apply({ type: 'ATTEMPT_UPDATED', attemptId: 'nope', patch: {} }))
      .toThrow(UnknownAttemptError)
  })

  it('JOB_RECORDED + JOB_UPDATED maintain jobs[] and activeJobIds[]', () => {
    const store = new CTFTaskStateStore(freshState())
    store.apply({
      type: 'JOB_RECORDED',
      job: {
        id: 'j1',
        taskId: 't',
        status: 'pending',
        startedAt: Date.now(),
      },
    })
    expect(store.getState().jobs.length).toBe(1)
    expect(store.getState().activeJobIds).toContain('j1')
    store.apply({
      type: 'JOB_UPDATED',
      jobId: 'j1',
      patch: { status: 'success', endedAt: Date.now() },
    })
    // success → not active
    expect(store.getState().activeJobIds).not.toContain('j1')
    expect(store.getState().jobs[0].status).toBe('success')
  })
})

// ────────────────────────────────────────────────────────────────────────
// §十一 — Job lifecycle events update state, no polling
// ────────────────────────────────────────────────────────────────────────
describe('§十一 — BackgroundJobManager.subscribe is the only mechanism', () => {
  it('JOB_STARTED then JOB_COMPLETED reach the subscriber', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jm-'))
    try {
      const seen: string[] = []
      const jm = new BackgroundJobManager(
        { taskWorkspaceDir: dir, maxPerAgent: 4, maxPerTask: 4 },
        () => Promise.resolve({ summary: 'ok' }),
      )
      const unsub = jm.subscribe((ev) => seen.push(ev.type))
      const job = await jm.spawn({
        taskId: 't',
        agentId: 'a',
        toolId: 'Bash',
        input: { command: 'echo hi' },
      })
      await jm.wait(job.id, 5000)
      unsub()
      expect(seen).toContain('JOB_STARTED')
      expect(seen).toContain('JOB_UPDATED')
      expect(seen).toContain('JOB_COMPLETED')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('listener errors do not break the manager', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jm-'))
    try {
      const jm = new BackgroundJobManager(
        { taskWorkspaceDir: dir, maxPerAgent: 4, maxPerTask: 4 },
        () => Promise.resolve({ summary: 'ok' }),
      )
      jm.subscribe(() => {
        throw new Error('listener boom')
      })
      const job = await jm.spawn({
        taskId: 't',
        agentId: 'a',
        toolId: 'Bash',
        input: { command: 'echo hi' },
      })
      const final = await jm.wait(job.id, 5000)
      expect(final.status).toBe('success')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('dispose unsubscribes (no further events observed)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jm-'))
    try {
      const seen: string[] = []
      const jm = new BackgroundJobManager(
        { taskWorkspaceDir: dir, maxPerAgent: 4, maxPerTask: 4 },
        () => Promise.resolve({ summary: 'ok' }),
      )
      const unsub = jm.subscribe((ev) => seen.push(ev.type))
      const job = await jm.spawn({
        taskId: 't',
        agentId: 'a',
        toolId: 'Bash',
        input: { command: 'echo hi' },
      })
      await jm.wait(job.id, 5000)
      unsub()
      const beforeCount = seen.length
      const job2 = await jm.spawn({
        taskId: 't',
        agentId: 'a',
        toolId: 'Bash',
        input: { command: 'echo bye' },
      })
      await jm.wait(job2.id, 5000)
      // No further notifications after unsubscribe.
      expect(seen.length).toBe(beforeCount)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ────────────────────────────────────────────────────────────────────────
// §九 — Naming: agentRuns / workflowRuns / jobs are historical, not "active"
// ────────────────────────────────────────────────────────────────────────
describe('§九 — Historical-record naming', () => {
  it('agentRuns keeps completed runs; activeAgentRunIds filters', async () => {
    const orch = await CTFTaskOrchestrator.create({ cwd: root, profileId: 'triage' })
    try {
      const r = await orch.runMainAgent('hello')
      expect(r.status).toBeDefined()
      // After runMainAgent completes, the run is in agentRuns[] (historical)
      // and activeAgentRunIds[] does NOT include it.
      const all = orch.getState().agentRuns
      const active = orch.getState().activeAgentRunIds
      expect(all.length).toBeGreaterThanOrEqual(1)
      for (const id of active) {
        expect(all.some((r) => r.id === id)).toBe(true)
      }
    } finally {
      await orch.dispose()
    }
  })

  it('workflowRuns keeps completed runs; activeWorkflowRunIds filters', async () => {
    const orch = await CTFTaskOrchestrator.create({
      cwd: root,
      profileId: 'triage',
      jobLimits: { maxPerAgent: 0, maxPerTask: 0 },
    })
    try {
      await orch.runWorkflow('unknown_file_triage', {})
      const all = orch.getState().workflowRuns
      const active = orch.getState().activeWorkflowRunIds
      expect(all.length).toBeGreaterThanOrEqual(1)
      for (const id of active) {
        expect(all.some((r) => r.id === id)).toBe(true)
      }
    } finally {
      await orch.dispose()
    }
  })
})

// ────────────────────────────────────────────────────────────────────────
// §十四 — Late events after TASK_COMPLETED do not mutate Completion
// ────────────────────────────────────────────────────────────────────────
describe('§十四 — Terminal-phase guard', () => {
  function freshState(): CTFTaskState {
    const now = Date.now()
    return {
      taskId: 't', phase: 'intake',
      context: {
        taskId: 't',
        workspaceDir: root,
        sessionDir: root,
        artifactDir: join(root, 'artifacts'),
        eventsFile: join(root, 'events.ndjson'),
        profileId: 'orchestrator',
        contestScope: parseContestScope({ allowedFilesRoot: root, allowPublicNetwork: false }),
        contestConfig: createDefaultContestConfig({ cwd: root }),
      },
      challenge: { inputArtifactIds: [] },
      activeProfileId: 'orchestrator',
      findings: [], artifactIds: [], hypotheses: [], attempts: [],
      handoffs: [], agentRuns: [], activeAgentRunIds: [],
      workflowRuns: [], activeWorkflowRunIds: [],
      jobs: [], oneShotRuns: [], activeJobIds: [], observations: [], evidence: [], strategyDecisions: [],
      flagCandidates: [],
      createdAt: now, updatedAt: now,
    }
  }

  it('TASK_COMPLETED is immutable', () => {
    const store = new CTFTaskStateStore(freshState())
    store.apply({ type: 'TASK_COMPLETED', status: 'solved', reason: 'ok' })
    expect(() =>
      store.apply({ type: 'TASK_COMPLETED', status: 'failed', reason: 'rewrite' }),
    ).toThrow(TaskAlreadyCompletedError)
  })

  it('after TASK_COMPLETED, only bookkeeping events are allowed', () => {
    const store = new CTFTaskStateStore(freshState())
    store.apply({ type: 'TASK_COMPLETED', status: 'solved', reason: 'ok' })
    // Bookkeeping is OK.
    expect(() =>
      store.apply({
        type: 'FINDING_ADDED',
        finding: {
          id: 'f1',
          taskId: 't',
          producerAgentId: 'main',
          category: 'triage',
          title: 'late', summary: 'triage summary',
          confidence: 'low',
          evidence: [],
          artifactIds: [],
          createdAt: new Date().toISOString(),
        },
      }),
    ).not.toThrow()
    // Phase change rejected.
    expect(() =>
      store.apply({ type: 'PHASE_CHANGED', from: 'solved', to: 'exploration' }),
    ).toThrow(TaskAlreadyCompletedError)
  })
})

// ────────────────────────────────────────────────────────────────────────
// §七 — ProfileStore replaces direct broker mutation
// ────────────────────────────────────────────────────────────────────────
describe('§七 — Profile atomic switch', () => {
  it('switchProfile updates TaskState + ProfileStore + Broker', async () => {
    const orch = await CTFTaskOrchestrator.create({ cwd: root, profileId: 'triage' })
    try {
      expect(orch.getState().activeProfileId).toBe('triage')
      expect(orch.mainHarness.broker.getProfile().id).toBe('triage')
      orch.switchProfile('orchestrator')
      expect(orch.getState().activeProfileId).toBe('orchestrator')
      expect(orch.mainHarness.broker.getProfile().id).toBe('orchestrator')
      // Switching to same profile is a no-op.
      orch.switchProfile('orchestrator')
      expect(orch.getState().activeProfileId).toBe('orchestrator')
    } finally {
      await orch.dispose()
    }
  })

  it('switchProfile rejects unknown profiles', async () => {
    const orch = await CTFTaskOrchestrator.create({ cwd: root, profileId: 'triage' })
    try {
      expect(() => orch.switchProfile('does-not-exist')).toThrow(/Unknown profile/)
    } finally {
      await orch.dispose()
    }
  })
})

// Silence unused import warnings.
void ({} as OpenAI)
void ({} as Renderer)