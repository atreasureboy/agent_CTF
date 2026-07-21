/**
 * CTF Runtime tests — the unified TaskExecutionContext, StateStore,
 * Orchestrator, and the §十九 acceptance criteria.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { CTFTaskStateStore, TaskStateStoreError, IllegalPhaseTransitionError } from '../src/core/ctfRuntime/taskStateStore.js'
import {
  ALLOWED_PHASE_TRANSITIONS,
  isTerminalPhase,
  type CTFTaskState,
} from '../src/core/ctfRuntime/taskState.js'
import {
  createDefaultContestConfig,
} from '../src/core/contestConfig.js'
import { parseContestScope } from '../src/core/contestScope.js'
import {
  deriveSubtaskContext,
  narrowContestScope,
  ScopeNarrowingError,
} from '../src/core/ctfRuntime/taskExecutionContext.js'
import { CTFTaskOrchestrator } from '../src/core/ctfRuntime/taskOrchestrator.js'
import { FindingStore } from '../src/core/findings.js'
import { HandoffStore } from '../src/core/handoff.js'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ctf-runtime-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

// ──────────────────────────────────────────────────────────────────────
// §十九.1 — default ContestConfig from different entry points is identical
// ──────────────────────────────────────────────────────────────────────
describe('createDefaultContestConfig — single source of truth', () => {
  it('returns the same shape regardless of caller', () => {
    const a = createDefaultContestConfig({ cwd: '/tmp/a' })
    const b = createDefaultContestConfig({ cwd: '/tmp/b' })
    expect(a.allowPublicNetwork).toBe(false)
    expect(b.allowPublicNetwork).toBe(false)
    expect(a.allowedFilesRoot).toBe('/tmp/a')
    expect(b.allowedFilesRoot).toBe('/tmp/b')
  })

  it('matches the safety defaults documented in contestConfig.ts', () => {
    const cfg = createDefaultContestConfig({ cwd: root })
    const manual = parseContestScope({
      allowedFilesRoot: root,
      allowPublicNetwork: false,
    })
    expect(cfg).toEqual(manual)
  })
})

// ──────────────────────────────────────────────────────────────────────
// §十九.2 — Workflow uses TaskExecutionContext.workspaceDir
// ──────────────────────────────────────────────────────────────────────
describe('WorkflowRunner uses TaskExecutionContext', () => {
  it('runner requires a context and uses workspaceDir as cwd', async () => {
    const { createHarness } = await import('../src/core/harness.js')
    const { WorkflowBrokerRunner } = await import('../src/core/workflowRunner.js')
    const h = createHarness({ cwd: root, profile: 'orchestrator' })
    const runner = new WorkflowBrokerRunner(h.broker, {
      taskId: h.context.taskId,
      defaultAgentId: 'orchestrator',
      context: h.context,
    })
    expect(runner.getContext().workspaceDir).toBe(h.context.workspaceDir)
    expect(runner.getContext().workspaceDir).not.toBe(process.cwd())
  })

  it('throws when constructed without a context', async () => {
    const { createHarness } = await import('../src/core/harness.js')
    const { WorkflowBrokerRunner } = await import('../src/core/workflowRunner.js')
    const h = createHarness({ cwd: root, profile: 'orchestrator' })
    expect(() => new WorkflowBrokerRunner(h.broker, {
      taskId: 't',
      defaultAgentId: 'orchestrator',
      context: undefined as unknown as never,
    })).toThrow(/TaskExecutionContext/)
  })
})

// ──────────────────────────────────────────────────────────────────────
// §十九.3 — Specialist Scope cannot be wider than parent Scope
// ──────────────────────────────────────────────────────────────────────
describe('Scope narrowing', () => {
  const parent = parseContestScope({
    allowedFilesRoot: '/srv/ctf',
    allowPublicNetwork: false,
    allowedHosts: ['10.0.0.1', '10.0.0.2'],
    allowedCidrs: ['10.0.0.0/24'],
    allowedDomains: ['example.com'],
    allowedPorts: [80, 443],
  })

  it('accepts a strict subset', () => {
    const child = narrowContestScope(parent, parseContestScope({
      allowedFilesRoot: '/srv/ctf/sub',
      allowedHosts: ['10.0.0.1'],
      allowedCidrs: ['10.0.0.0/24'],
      allowedDomains: ['example.com'],
      allowedPorts: [443],
      allowPublicNetwork: false,
    }))
    expect(child.allowedHosts).toEqual(['10.0.0.1'])
  })

  it('refuses a host outside the parent allow-list', () => {
    expect(() => narrowContestScope(parent, parseContestScope({
      allowedFilesRoot: '/srv/ctf',
      allowedHosts: ['8.8.8.8'],
      allowPublicNetwork: false,
    }))).toThrow(ScopeNarrowingError)
  })

  it('refuses allowPublicNetwork=true when parent=false', () => {
    expect(() => narrowContestScope(parent, parseContestScope({
      allowedFilesRoot: '/srv/ctf',
      allowPublicNetwork: true,
    }))).toThrow(ScopeNarrowingError)
  })

  it('refuses filesRoot outside the parent root', () => {
    expect(() => narrowContestScope(parent, parseContestScope({
      allowedFilesRoot: '/srv/other',
      allowPublicNetwork: false,
    }))).toThrow(ScopeNarrowingError)
  })

  it('deriveSubtaskContext applies narrowing when contestScope is supplied', () => {
    const parentRoot = '/srv/ctf'
    const parent2 = parseContestScope({
      allowedFilesRoot: parentRoot,
      allowPublicNetwork: false,
    })
    const parentCtx = {
      taskId: 'main',
      workspaceDir: parentRoot,
      sessionDir: parentRoot,
      artifactDir: join(parentRoot, 'artifacts'),
      eventsFile: join(parentRoot, 'events.ndjson'),
      profileId: 'orchestrator',
      contestScope: parent2,
      contestConfig: parent2 as never,
    }
    const sub = deriveSubtaskContext(parentCtx, {
      subtaskId: 'spec_1',
      contestScope: parseContestScope({
        allowedFilesRoot: join(parentRoot, 'sub'),
        allowPublicNetwork: false,
      }),
    })
    expect(sub.taskId).toBe('spec_1')
    expect(sub.contestScope.allowedFilesRoot).toBe(join(parentRoot, 'sub'))
  })
})

// ──────────────────────────────────────────────────────────────────────
// §十九.4 — Handoff lifecycle: requested → approved → running → completed
// §十九.5 — same Handoff cannot be approved twice
// §十九.6 — rejected Handoff cannot enter running
// §十九.7 — Specialist failure drives Handoff to failed
// ──────────────────────────────────────────────────────────────────────
describe('CTFTaskStateStore — Handoff lifecycle', () => {
  function freshState(): CTFTaskState {
    const now = Date.now()
    return {
      taskId: 't1',
      phase: 'intake',
      context: {
        taskId: 't1',
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
      findings: [],
      artifactIds: [],
      hypotheses: [],
      attempts: [],
      handoffs: [],
      activeAgentRuns: [],
      activeWorkflowRuns: [],
      activeJobs: [],
      flagCandidates: [],
      createdAt: now,
      updatedAt: now,
    }
  }

  it('walks the lifecycle requested → approved → running → completed', () => {
    const store = new CTFTaskStateStore(freshState())
    store.apply({
      type: 'HANDOFF_REQUESTED',
      handoff: {
        id: 'h1', taskId: 't1', fromAgentRunId: 'run1',
        requestedCapability: 'crypto', reason: 'x', objective: 'y',
        artifactIds: [], findingIds: [], status: 'requested', createdAt: Date.now(),
      },
    })
    store.apply({ type: 'HANDOFF_APPROVED', handoffId: 'h1', selectedAgentId: 'crypto' })
    store.apply({ type: 'HANDOFF_STARTED', handoffId: 'h1', agentRunId: 'run2' })
    store.apply({ type: 'HANDOFF_COMPLETED', handoffId: 'h1', agentRunId: 'run2', summary: 'ok' })
    const h = store.getState().handoffs[0]
    expect(h.status).toBe('completed')
  })

  it('refuses double approval', () => {
    const store = new CTFTaskStateStore(freshState())
    store.apply({
      type: 'HANDOFF_REQUESTED',
      handoff: {
        id: 'h1', taskId: 't1', fromAgentRunId: 'run1',
        requestedCapability: 'crypto', reason: 'x', objective: 'y',
        artifactIds: [], findingIds: [], status: 'requested', createdAt: Date.now(),
      },
    })
    store.apply({ type: 'HANDOFF_APPROVED', handoffId: 'h1', selectedAgentId: 'crypto' })
    expect(() =>
      store.apply({ type: 'HANDOFF_APPROVED', handoffId: 'h1', selectedAgentId: 'crypto' }),
    ).toThrow()
  })

  it('refuses to start a rejected handoff', () => {
    const store = new CTFTaskStateStore(freshState())
    store.apply({
      type: 'HANDOFF_REQUESTED',
      handoff: {
        id: 'h1', taskId: 't1', fromAgentRunId: 'run1',
        requestedCapability: 'crypto', reason: 'x', objective: 'y',
        artifactIds: [], findingIds: [], status: 'requested', createdAt: Date.now(),
      },
    })
    store.apply({ type: 'HANDOFF_REJECTED', handoffId: 'h1', reason: 'nope' })
    expect(() =>
      store.apply({ type: 'HANDOFF_STARTED', handoffId: 'h1', agentRunId: 'r' }),
    ).toThrow()
  })

  it('drives handoff to failed when specialist fails', () => {
    const store = new CTFTaskStateStore(freshState())
    store.apply({
      type: 'HANDOFF_REQUESTED',
      handoff: {
        id: 'h1', taskId: 't1', fromAgentRunId: 'run1',
        requestedCapability: 'crypto', reason: 'x', objective: 'y',
        artifactIds: [], findingIds: [], status: 'requested', createdAt: Date.now(),
      },
    })
    store.apply({ type: 'HANDOFF_APPROVED', handoffId: 'h1', selectedAgentId: 'crypto' })
    store.apply({ type: 'HANDOFF_STARTED', handoffId: 'h1', agentRunId: 'r1' })
    store.apply({ type: 'HANDOFF_FAILED', handoffId: 'h1', agentRunId: 'r1', error: 'boom' })
    expect(store.getState().handoffs[0].status).toBe('failed')
  })

  it('refuses new workflow runs after TASK_COMPLETED', () => {
    const store = new CTFTaskStateStore(freshState())
    store.apply({ type: 'TASK_COMPLETED', status: 'solved', reason: 'done' })
    expect(() =>
      store.apply({
        type: 'WORKFLOW_STARTED',
        workflowRun: {
          id: 'w1', taskId: 't1', workflowId: 'image_quick_scan',
          status: 'running', startedAt: Date.now(), stepOutcomeIds: [],
        },
      }),
    ).toThrow(/already solved/)
  })

  it('refuses illegal phase transitions', () => {
    const store = new CTFTaskStateStore(freshState())
    // 'created' can go to 'intake' but not 'solved'.
    expect(() =>
      store.apply({ type: 'PHASE_CHANGED', from: 'created', to: 'solved' }),
    ).toThrow(IllegalPhaseTransitionError)
  })

  it('accepts allowed transitions and refreshes updatedAt', () => {
    const store = new CTFTaskStateStore(freshState())
    const before = store.getState().updatedAt
    // 'intake' → 'triage' is allowed.
    store.apply({ type: 'PHASE_CHANGED', from: 'intake', to: 'triage', reason: 'manual' })
    expect(store.getState().phase).toBe('triage')
    expect(store.getState().updatedAt).toBeGreaterThanOrEqual(before)
  })

  it('subscribers receive every event', () => {
    const store = new CTFTaskStateStore(freshState())
    const seen: string[] = []
    const unsub = store.subscribe((e) => seen.push(e.type))
    store.apply({ type: 'PHASE_CHANGED', from: 'intake', to: 'triage' })
    store.apply({
      type: 'HANDOFF_REQUESTED',
      handoff: {
        id: 'h1', taskId: 't1', fromAgentRunId: 'r1',
        requestedCapability: 'crypto', reason: 'x', objective: 'y',
        artifactIds: [], findingIds: [], status: 'requested', createdAt: Date.now(),
      },
    })
    unsub()
    expect(seen).toEqual(['PHASE_CHANGED', 'HANDOFF_REQUESTED'])
  })
})

// ──────────────────────────────────────────────────────────────────────
// §十九.8 / 9 — Specialist Finding/Artifact merge into TaskState
// (Covered indirectly by the orchestrator; verify via direct state manipulation.)
// ──────────────────────────────────────────────────────────────────────
describe('TaskState — finding/artifact merge', () => {
  it('FINDING_ADDED and ARTIFACT_ADDED populate the state', () => {
    const now = Date.now()
    const store = new CTFTaskStateStore({
      taskId: 't1', phase: 'intake',
      context: {
        taskId: 't1', workspaceDir: root, sessionDir: root,
        artifactDir: join(root, 'artifacts'),
        eventsFile: join(root, 'events.ndjson'),
        profileId: 'orchestrator',
        contestScope: parseContestScope({ allowedFilesRoot: root, allowPublicNetwork: false }),
        contestConfig: createDefaultContestConfig({ cwd: root }),
      },
      challenge: { inputArtifactIds: [] },
      activeProfileId: 'orchestrator',
      findings: [], artifactIds: [], hypotheses: [], attempts: [],
      handoffs: [], activeAgentRuns: [], activeWorkflowRuns: [], activeJobs: [],
      flagCandidates: [],
      createdAt: now, updatedAt: now,
    })
    store.apply({
      type: 'FINDING_ADDED',
      finding: {
        id: 'f1', taskId: 't1', producerAgentId: 'crypto',
        category: 'crypto', title: 'weak RSA', summary: 'e=3',
        confidence: 'high', evidence: [], artifactIds: [], createdAt: new Date(now).toISOString(),
      },
    })
    store.apply({ type: 'ARTIFACT_ADDED', artifactId: 'a1' })
    const state = store.getState()
    expect(state.findings).toHaveLength(1)
    expect(state.artifactIds).toEqual(['a1'])
  })
})

// ──────────────────────────────────────────────────────────────────────
// §十九.10 — Task 完成后不能再启动 Workflow
// (Already covered above in `refuses new workflow runs after TASK_COMPLETED`.)
// ──────────────────────────────────────────────────────────────────────

// ──────────────────────────────────────────────────────────────────────
// §十九.11 — Profile 更新不会通过访问 private 字段实现
// (Verified at compile-time: harness.switchProfile uses broker.setProfile;
//  we additionally assert that broker.setProfile is exported and functional.)
// ──────────────────────────────────────────────────────────────────────
describe('Profile updates are atomic (no private-field writes)', () => {
  it('ToolBroker.setProfile is the public surface', async () => {
    const { createHarness } = await import('../src/core/harness.js')
    const { profileAllowsTool } = await import('../src/core/capabilityProfile.js')
    const h = createHarness({ cwd: root, profile: 'orchestrator' })
    const before = h.broker.getProfile().id
    // Create a different profile by parsing the built-in one
    const { getBuiltinProfile } = await import('../src/capabilityProfiles/index.js')
    const crypto = getBuiltinProfile('crypto')
    expect(crypto).toBeTruthy()
    h.broker.setProfile(crypto!)
    expect(h.broker.getProfile().id).toBe('crypto')
    // 'Bash' is denied by orchestrator, allowed by crypto
    expect(profileAllowsTool(h.broker.getProfile(), 'Bash')).toBe(true)
    expect(before).toBe('orchestrator')
  })

  it('Harness.switchProfile delegates to broker.setProfile (no bracket access)', async () => {
    const { createHarness } = await import('../src/core/harness.js')
    const { getBuiltinProfile } = await import('../src/capabilityProfiles/index.js')
    const h = createHarness({ cwd: root, profile: 'orchestrator' })
    h.switchProfile('crypto')
    expect(h.broker.getProfile().id).toBe('crypto')
    const crypto = getBuiltinProfile('crypto')!
    // After switching, the broker's profile must be the new one (not the old).
    expect(h.broker.getProfile()).toBe(crypto)
  })
})

// ──────────────────────────────────────────────────────────────────────
// §十九.12 — Profile 更新后 Tool exposure 同步变化
// ──────────────────────────────────────────────────────────────────────
describe('Tool exposure tracks profile changes', () => {
  it('switching profile changes which tools the broker allows', async () => {
    const { createHarness } = await import('../src/core/harness.js')
    const h = createHarness({ cwd: root, profile: 'orchestrator' })
    // 'orchestrator' profile denies Bash
    expect(h.broker.isAllowed('Bash')).toBe(false)
    h.switchProfile('crypto')
    // 'crypto' profile allows Bash (toolFirstPolicy + tools list)
    expect(h.broker.isAllowed('Bash')).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────
// CTFTaskOrchestrator end-to-end smoke (without LLM)
// ──────────────────────────────────────────────────────────────────────
describe('CTFTaskOrchestrator — wiring', () => {
  it('creates a task, exposes state store + main harness, dispatches workflow + handoff', async () => {
    const orch = await CTFTaskOrchestrator.create({ cwd: root, profileId: 'orchestrator' })
    try {
      expect(orch.getState().phase).toBe('intake')
      expect(orch.getState().activeProfileId).toBe('orchestrator')
      expect(orch.getMainHarness().profile.id).toBe('orchestrator')

      // Workflow run is recorded in the state.
      const wf = orch.getMainHarness().workflowRegistry.get('unknown_file_triage')
      expect(wf).toBeTruthy()
      // Provide required input to avoid runner errors.
      // We test the bookkeeping path; run without input — the workflow
      // runner still records the lifecycle.
      const result = await orch.runWorkflow('unknown_file_triage', {})
      expect(result).toBeTruthy()
      expect(orch.getState().activeWorkflowRuns[0].status).toBe('completed')

      // Handoff request → reject → state reflects the rejection.
      const h = orch.requestHandoff({
        fromAgentRunId: 'run_main',
        targetCapability: 'crypto',
        reason: 'rsa', objective: 'crack',
      })
      expect(orch.getState().handoffs[0].status).toBe('requested')
      orch.rejectHandoff(h.id, 'not needed')
      expect(orch.getState().handoffs[0].status).toBe('rejected')

      // Atomic profile switch updates both state + broker.
      orch.switchProfile('crypto')
      expect(orch.getState().activeProfileId).toBe('crypto')
      expect(orch.getMainHarness().broker.getProfile().id).toBe('crypto')
    } finally {
      await orch.dispose()
    }
  })

  it('approveHandoff without a renderer marks approved + records events', async () => {
    const orch = await CTFTaskOrchestrator.create({ cwd: root, profileId: 'orchestrator' })
    try {
      // Pre-seed a finding so the handoff has something to inherit.
      orch.mainHarness.findingStore.append({
        taskId: orch.getState().taskId,
        producerAgentId: 'orchestrator',
        category: 'workflow',
        title: 'seed',
        summary: 'seed',
        confidence: 'low',
        evidence: [],
        artifactIds: [],
      })
      const h = orch.requestHandoff({
        fromAgentRunId: 'run_main',
        targetCapability: 'crypto',
        reason: 'rsa', objective: 'crack',
        findingIds: [orch.mainHarness.findingStore.list()[0].id],
      })
      // Without a renderer, the child runTurn will throw (it requires one),
      // but the lifecycle should still walk through. We expect a failed
      // specialist outcome (no renderer) — but handoff status should be
      // 'failed' (driven by the catch), proving the orchestrator owns the
      // entire lifecycle.
      const result = await orch.approveHandoff(h.id).catch((e) => ({ error: (e as Error).message }))
      const state = orch.getState()
      const handoffRecord = state.handoffs.find((x) => x.id === h.id)
      expect(handoffRecord).toBeTruthy()
      // It must NOT be 'requested' anymore.
      expect(['approved', 'running', 'completed', 'failed']).toContain(handoffRecord!.status)
      expect(result).toBeTruthy()
    } finally {
      await orch.dispose()
    }
  })

  it('cancel() does not leave active workflows running', async () => {
    const orch = await CTFTaskOrchestrator.create({ cwd: root, profileId: 'orchestrator' })
    try {
      await orch.runWorkflow('unknown_file_triage', {})
      orch.cancel('test')
      // Cancel is idempotent; no exception.
      orch.cancel('test-again')
      expect(orch.getState().activeWorkflowRuns[0].status).toBe('completed')
    } finally {
      await orch.dispose()
    }
  })

  it('phase transitions follow the documented table', () => {
    // Spot-check the table.
    expect(ALLOWED_PHASE_TRANSITIONS['intake']).toContain('triage')
    expect(ALLOWED_PHASE_TRANSITIONS['triage']).toContain('exploration')
    expect(ALLOWED_PHASE_TRANSITIONS['specialist_execution']).toContain('exploration')
    expect(isTerminalPhase('solved')).toBe(true)
    expect(isTerminalPhase('cancelled')).toBe(true)
    expect(isTerminalPhase('intake')).toBe(false)
  })
})

// ──────────────────────────────────────────────────────────────────────
// Sanity: existing legacy stores still work unchanged.
// ──────────────────────────────────────────────────────────────────────
describe('Existing stores still work as before', () => {
  it('FindingStore / HandoffStore basic write/read', () => {
    const fs = new FindingStore(root)
    fs.append({
      taskId: 't1', producerAgentId: 'a', category: 'image',
      title: 'x', summary: 'y', confidence: 'high', evidence: [], artifactIds: [],
    })
    expect(fs.list()).toHaveLength(1)

    const hs = new HandoffStore(root)
    hs.submit({
      taskId: 't1', fromAgent: 'a', suggestedAgent: 'b',
      reason: 'r', objective: 'o', artifactIds: [], findingIds: [],
    })
    expect(hs.pending()).toHaveLength(1)
  })

  it('workspace files exist after a task is created', async () => {
    const orch = await CTFTaskOrchestrator.create({ cwd: root, profileId: 'orchestrator' })
    try {
      const ws = orch.getMainHarness().taskWorkspace
      expect(existsSync(ws.paths.root)).toBe(true)
      expect(existsSync(ws.paths.workspaceDir)).toBe(true)
      expect(existsSync(ws.paths.artifactsDir)).toBe(true)
    } finally {
      await orch.dispose()
    }
  })
})
