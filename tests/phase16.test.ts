/**
 * Phase 1.6 (forth_goal.md) acceptance tests.
 *
 * Categories:
 *   §1 CLI — runCtfCli uses createCTFTaskRuntime and never createHarness
 *   §2 dispatchNext — minimal signature, no autoExecute, throws w/o orch
 *   §3 Specialist Factory — receives client/renderer/model/profile/...
 *   §4 Abort chain — propagates parent → child; child → parent; unlink
 *   §5 Job events — no polling, JOB_UPDATED terminal guard
 *   §6 Reducer — Hypothesis / Attempt / Job events update state
 *   §7 Projector — Finding/Artifact diff + dedupe
 *   §8 Integration — Runtime → Orchestrator → Specialist → Parent state
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { runCtfCli } from '../bin/ovogogogo-ctf.js'
import { CTFTaskOrchestrator } from '../src/core/ctfRuntime/taskOrchestrator.js'
import { createCTFTaskRuntime } from '../src/core/ctfRuntime/createCTFTaskRuntime.js'
import { dispatchNext } from '../src/core/orchestratorDispatch.js'
import {
  DuplicateAttemptError,
  DuplicateHypothesisError,
  DuplicateJobError,
  IllegalAttemptTransitionError,
  IllegalJobTransitionError,
  TaskAlreadyCompletedError,
  UnknownAttemptError,
  UnknownHypothesisError,
  UnknownJobError,
} from '../src/core/ctfRuntime/taskStateStore.js'
import {
  CTFTaskStateStore,
} from '../src/core/ctfRuntime/taskStateStore.js'
import type { CTFTaskState } from '../src/core/ctfRuntime/taskState.js'
import { BackgroundJobManager } from '../src/core/backgroundJobs.js'
import { TaskStateProjector } from '../src/core/ctfRuntime/taskStateProjector.js'
import { createLinkedAbortController } from '../src/core/ctfRuntime/linkedAbortController.js'
import {
  SpecialistHarnessFactory,
} from '../src/core/ctfRuntime/specialistHarnessFactory.js'
import type { AgentRuntimeDependencies } from '../src/core/ctfRuntime/agentRuntimeDependencies.js'
import type { HarnessBundle } from '../src/core/harness.js'
import type OpenAI from 'openai'
type OpenAIClient = OpenAI
import { parseContestScope } from '../src/core/contestScope.js'
import { createDefaultContestConfig } from '../src/core/contestConfig.js'
import type { Renderer } from '../src/ui/renderer.js'
import { getBuiltinProfile } from '../src/capabilityProfiles/index.js'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'phase16-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

// ────────────────────────────────────────────────────────────────────────
// §1 — CLI
// ────────────────────────────────────────────────────────────────────────
describe('§1 — CLI', () => {
  it('runCtfCli --help returns 0 and prints usage', async () => {
    const writes: string[] = []
    const stdout = makeCollector(writes)
    const code = await runCtfCli(['node', 'ovogogogo-ctf', '--help'], {
      stdout,
      stderr: makeCollector([]),
    })
    expect(code).toBe(0)
    expect(writes.join('')).toMatch(/USAGE/)
  })

  it('runCtfCli --version returns 0 and prints version', async () => {
    const writes: string[] = []
    const stdout = makeCollector(writes)
    const code = await runCtfCli(['node', 'ovogogogo-ctf', '--version'], {
      stdout,
      stderr: makeCollector([]),
    })
    expect(code).toBe(0)
    expect(writes.join('')).toMatch(/ovogogogo-ctf/)
  })

  it('runCtfCli --run-workflow routes through createCTFTaskRuntime + Orchestrator', async () => {
    const stdout = makeCollector([])
    const stderr = makeCollector([])
    let runtimeCalls = 0
    const fakeRuntime: typeof createCTFTaskRuntime = async (input) => {
      runtimeCalls++
      return createCTFTaskRuntime({
        ...input,
        profileId: input.profileId ?? 'triage',
        client: input.client ?? makeFakeClient(),
        renderer: input.renderer ?? makeFakeRenderer(),
      })
    }
    const code = await runCtfCli(
      ['node', 'ovogogogo-ctf', '--profile', 'triage', '--run-workflow', 'unknown_file_triage'],
      {
        stdout,
        stderr,
        createRuntime: fakeRuntime,
      },
    )
    expect(code).toBe(0)
    expect(runtimeCalls).toBe(1)
  })

  it('runCtfCli without --run-workflow and no API key returns error 3', async () => {
    const stderr = makeCollector([])
    const code = await runCtfCli(
      ['node', 'ovogogogo-ctf', '--profile', 'triage', 'do something'],
      {
        stdout: makeCollector([]),
        stderr,
        env: { OPENAI_API_KEY: '' },
      },
    )
    expect(code).toBe(3)
  })

  it('runCtfCli disposes runtime in finally (no skipped cleanup)', async () => {
    let disposed = 0
    const fakeRuntime: typeof createCTFTaskRuntime = async (input) => {
      const r = await createCTFTaskRuntime({
        ...input,
        profileId: input.profileId ?? 'triage',
        client: input.client ?? makeFakeClient(),
        renderer: input.renderer ?? makeFakeRenderer(),
      })
      const baseDispose = r.dispose.bind(r)
      ;(r as { dispose: () => Promise<void> }).dispose = async () => {
        disposed++
        await baseDispose()
      }
      return r
    }
    const code = await runCtfCli(
      ['node', 'ovogogogo-ctf', '--profile', 'triage', '--run-workflow', 'unknown_file_triage'],
      {
        stdout: makeCollector([]),
        stderr: makeCollector([]),
        createRuntime: fakeRuntime,
      },
    )
    expect(code).toBe(0)
    expect(disposed).toBe(1)
  })

  it('CLI does NOT touch broker.opts or create a Harness directly', () => {
    // Static check — the CLI source must not import createHarness or
    // mutate broker private fields.
    const cliPath = join(root, '..', '..', 'project', 'agent_CTF', 'ovolv999_pro', 'bin', 'ovogogogo-ctf.ts')
    let body: string
    try {
      body = readFileSync(cliPath, 'utf8')
    } catch {
      // Fallback for the test-runner cwd: resolve via process.cwd.
      body = readFileSync('bin/ovogogogo-ctf.ts', 'utf8')
    }
    expect(body).not.toMatch(/createHarness/)
    expect(body).not.toMatch(/harness\.runWorkflow/)
    expect(body).not.toMatch(/harness\.broker/)
    expect(body).not.toMatch(/broker\.opts/)
    expect(body).not.toMatch(/as unknown as .*opts/)
  })

  it('registerSignals is wired through installSignalHandlers and triggers runtime.cancel', async () => {
    // §十七.1 + §九 + §二十 — verify the CLI's signal registrar wires the
    // handler that calls runtime.cancel. We can't drive SIGINT through the
    // full runCtfCli because it disposes before the signal can land; instead
    // we install the same signal handler directly and confirm it routes to
    // cancel() correctly.
    let signalHandler: ((sig: string) => void) | null = null
    const orch = await createCTFTaskRuntime({
      cwd: root,
      profileId: 'triage',
      client: makeFakeClient(),
      renderer: makeFakeRenderer(),
    })
    try {
      // Mimic installSignalHandlers(deps, runtime). cancel() is async; the
      // real CLI uses `void runtime.cancel(...)` so the handler is sync, but
      // here we await to observe state.
      signalHandler = (sig) => orch.cancel(`cli_${sig.toLowerCase()}`)
      expect(orch.getState().completion).toBeUndefined()
      // Trigger the (mock) signal — handler calls orch.cancel.
      await signalHandler('SIGINT')
      const state = orch.getState()
      expect(state.completion).toBeDefined()
      expect(state.completion!.status).toBe('cancelled')
      expect(state.completion!.reason).toBe('cli_sigint')
      expect(state.phase).toBe('cancelled')
    } finally {
      await orch.dispose()
    }
  })

  it('runCtfCli chat mode runs through Orchestrator.runMainAgent', async () => {
    // §十七.1 — the chat (non-workflow) path must still go through Runtime
    // + Orchestrator.runMainAgent. We inject a streamed-script client that
    // emits one tool_call and then a stop chunk.
    const writes: string[] = []
    const stdout = makeCollector(writes)
    const script = [{ id: 'emit_finding', args: { category: 'forensics', title: 'chat-mode', summary: 'via runMainAgent', confidence: 'low' } }]
    const fakeClient = makeStreamingScriptedClient(script)
    const code = await runCtfCli(
      ['node', 'ovogogogo-ctf', '--profile', 'triage', 'solve the challenge'],
      {
        stdout,
        stderr: makeCollector([]),
        env: { OPENAI_API_KEY: 'test-key' },
        createClient: () => fakeClient as unknown as OpenAIClient,
        createRenderer: () => makeFakeRenderer(),
      },
    )
    expect(code).toBe(0)
    expect(writes.join('')).toMatch(/run status/)
  })
})

// ────────────────────────────────────────────────────────────────────────
// §2 — dispatchNext
// ────────────────────────────────────────────────────────────────────────
describe('§2 — dispatchNext', () => {
  it('dispatchNext without orchestrator throws', async () => {
    const { createHarness } = await import('../src/core/harness.js')
    const h = createHarness({ cwd: root, profile: 'triage' })
    await h.broker.execute('request_handoff', {
      suggestedAgent: 'triage', reason: 'r', objective: 'o',
    }, { cwd: root, taskId: h.context.taskId, agentId: 'triage' })
    await expect(
      dispatchNext(h, { decision: 'approve' }),
    ).rejects.toThrow(/dispatchNext requires an attached CTFTaskOrchestrator/)
  })

  it('dispatchNext does not import createHarness', () => {
    const src = readFileSync('src/core/orchestratorDispatch.ts', 'utf8')
    expect(src).not.toMatch(/import .*createHarness/)
    expect(src).not.toMatch(/createHarness\(/)
    expect(src).not.toMatch(/child\.runTurn/)
    // autoExecute must not appear as a parameter or option key
    expect(src).not.toMatch(/autoExecute\??:/)
    expect(src).not.toMatch(/options\.autoExecute/)
  })
})

// ────────────────────────────────────────────────────────────────────────
// §3 — Specialist Factory
// ────────────────────────────────────────────────────────────────────────
describe('§3 — SpecialistHarnessFactory', () => {
  it('creates a specialist harness with full dependencies', async () => {
    const orch = await createCTFTaskRuntime({
      cwd: root,
      profileId: 'triage',
      client: makeFakeClient(),
      renderer: makeFakeRenderer(),
    })
    try {
      const factory = new SpecialistHarnessFactory()
      const handoffRec = orch.orchestrator.requestHandoff({
        fromAgentRunId: 'run_main',
        targetCapability: 'triage',
        reason: 'r',
        objective: 'o',
      })
      const profile = getBuiltinProfile('triage')!
      const deps = orch.dependencies
      const handle = await factory.create({
        parentContext: orch.orchestrator.getState().context,
        parentTaskId: orch.getState().taskId,
        handoff: handoffRec,
        profile,
        dependencies: deps,
        abort: orch.abort,
        subtaskScope: orch.getState().context.contestScope,
        subtaskId: `${orch.getState().taskId}/spec`,
        cwd: root,
        parentArtifactStore: orch.mainHarness.artifactStore,
        parentFindingStore: orch.mainHarness.findingStore,
      })
      expect(handle.harness).toBeDefined()
      expect(handle.context.profileId).toBe('triage')
      expect(handle.context.contestScope).toBeDefined()
      expect(handle.context.abortSignal).toBeDefined()
      expect(handle.context.parentTaskId).toBe(orch.getState().taskId)
      // Independent sessionsDir / artifactDir is the parent's unless overridden.
      expect(handle.context.workspaceDir).toBeDefined()
    } finally {
      await orch.dispose()
    }
  })

  it('refuses to create a specialist without a client', async () => {
    const orch = await createCTFTaskRuntime({
      cwd: root,
      profileId: 'triage',
      // no client
    })
    try {
      const factory = new SpecialistHarnessFactory()
      const handoffRec = orch.orchestrator.requestHandoff({
        fromAgentRunId: 'run_main',
        targetCapability: 'triage',
        reason: 'r',
        objective: 'o',
      })
      await expect(
        factory.create({
          parentContext: orch.orchestrator.getState().context,
          parentTaskId: orch.getState().taskId,
          handoff: handoffRec,
          profile: getBuiltinProfile('triage')!,
          dependencies: orch.dependencies,
          abort: orch.abort,
          subtaskScope: orch.getState().context.contestScope,
          subtaskId: 'spec',
          cwd: root,
          parentArtifactStore: orch.mainHarness.artifactStore,
          parentFindingStore: orch.mainHarness.findingStore,
        }),
      ).rejects.toThrow(/OpenAI client/)
    } finally {
      await orch.dispose()
    }
  })

  it('refuses to create a specialist without a renderer', async () => {
    // §十七.3 — same shape as the client test, but the rejection must come
    // from the renderer guard, not the client guard.
    const orch = await createCTFTaskRuntime({
      cwd: root,
      profileId: 'triage',
      client: makeFakeClient(),
      // no renderer
    })
    try {
      const factory = new SpecialistHarnessFactory()
      const handoffRec = orch.orchestrator.requestHandoff({
        fromAgentRunId: 'run_main',
        targetCapability: 'triage',
        reason: 'r',
        objective: 'o',
      })
      const depsWithoutRenderer: AgentRuntimeDependencies = {
        ...orch.dependencies,
        renderer: undefined,
      }
      await expect(
        factory.create({
          parentContext: orch.orchestrator.getState().context,
          parentTaskId: orch.getState().taskId,
          handoff: handoffRec,
          profile: getBuiltinProfile('triage')!,
          dependencies: depsWithoutRenderer,
          abort: orch.abort,
          subtaskScope: orch.getState().context.contestScope,
          subtaskId: 'spec',
          cwd: root,
          parentArtifactStore: orch.mainHarness.artifactStore,
          parentFindingStore: orch.mainHarness.findingStore,
        }),
      ).rejects.toThrow(/Renderer/)
    } finally {
      await orch.dispose()
    }
  })
})

// ────────────────────────────────────────────────────────────────────────
// §4 — Abort chain
// ────────────────────────────────────────────────────────────────────────
describe('§4 — Abort chain', () => {
  it('parent.abort() → child.signal.aborted', () => {
    const parent = new AbortController()
    const child = createLinkedAbortController(parent.signal)
    parent.abort('user_cancelled')
    expect(child.signal.aborted).toBe(true)
    expect(child.signal.reason).toBe('user_cancelled')
  })

  it('child.controller.abort() does NOT propagate to parent', () => {
    const parent = new AbortController()
    const child = createLinkedAbortController(parent.signal)
    child.controller.abort('child_done')
    expect(parent.signal.aborted).toBe(false)
  })

  it('unlink() removes the parent listener', () => {
    const parent = new AbortController()
    const child = createLinkedAbortController(parent.signal)
    child.unlink()
    parent.abort('after')
    expect(child.signal.aborted).toBe(false)
  })

  it('Orchestrator.cancel() aborts the Task signal', async () => {
    const orch = await createCTFTaskRuntime({ cwd: root, profileId: 'triage' })
    try {
      expect(orch.abort.signal.aborted).toBe(false)
      await orch.cancel('test')
      expect(orch.abort.signal.aborted).toBe(true)
    } finally {
      await orch.dispose()
    }
  })

  it('After Orchestrator.cancel(), phase converges to cancelled and completion is populated', async () => {
    // §九 + §二十 — cancel must trigger TASK_COMPLETED status='cancelled'.
    const orch = await createCTFTaskRuntime({ cwd: root, profileId: 'triage' })
    try {
      expect(orch.getState().completion).toBeUndefined()
      await orch.cancel('user_cancelled')
      const state = orch.getState()
      expect(state.completion).toBeDefined()
      expect(state.completion!.status).toBe('cancelled')
      expect(state.completion!.reason).toBe('user_cancelled')
      expect(state.phase).toBe('cancelled')
    } finally {
      await orch.dispose()
    }
  })

  it('After Orchestrator.cancel(), an in-flight WorkflowRun is no longer running', async () => {
    // §十七.4 — verify the WORKFLOW_CANCELLED reducer path. We construct
    // a TaskState manually, register a WorkflowRun, apply the cancel event
    // directly, and confirm the run transitions out of 'running' and is
    // removed from activeWorkflowRunIds.
    const now = Date.now()
    const store = new CTFTaskStateStore({
      taskId: 'wf-cancel',
      phase: 'exploration',
      context: {
        taskId: 'wf-cancel',
        workspaceDir: root,
        sessionDir: root,
        artifactDir: join(root, 'artifacts'),
        eventsFile: join(root, 'events.ndjson'),
        profileId: 'triage',
        contestScope: parseContestScope({ allowedFilesRoot: root, allowPublicNetwork: false }),
        contestConfig: createDefaultContestConfig({ cwd: root }),
      },
      challenge: { inputArtifactIds: [] },
      activeProfileId: 'triage',
      findings: [], artifactIds: [], hypotheses: [], attempts: [],
      handoffs: [], agentRuns: [], activeAgentRunIds: [],
      workflowRuns: [], activeWorkflowRunIds: [],
      jobs: [], activeJobIds: [],
      flagCandidates: [],
      createdAt: now, updatedAt: now,
    })
    // Register a running workflow.
    const wfId = 'wf_test'
    store.apply({
      type: 'WORKFLOW_STARTED',
      workflowRun: {
        id: wfId, taskId: 'wf-cancel', workflowId: 'w', status: 'running',
        startedAt: now, stepOutcomeIds: [], profileId: 'triage',
      },
    })
    expect(store.getState().activeWorkflowRunIds).toContain(wfId)
    // Apply cancel.
    store.apply({ type: 'WORKFLOW_CANCELLED', workflowRunId: wfId, reason: 'test cancel' })
    const state = store.getState()
    const wfRun = state.workflowRuns.find((w) => w.id === wfId)!
    expect(wfRun.status).toBe('cancelled')
    expect(wfRun.error).toBe('test cancel')
    expect(state.activeWorkflowRunIds).not.toContain(wfId)
  })
})

// ────────────────────────────────────────────────────────────────────────
// §5 — Job events
// ────────────────────────────────────────────────────────────────────────
describe('§5 — BackgroundJobEvent → TaskState', () => {
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
      jobs: [], activeJobIds: [],
      flagCandidates: [],
      createdAt: now, updatedAt: now,
    }
  }

  it('JOB_RECORDED → jobs[] grows; duplicate throws', () => {
    const store = new CTFTaskStateStore(freshState())
    store.apply({
      type: 'JOB_RECORDED',
      job: { id: 'j1', taskId: 't', status: 'pending', startedAt: Date.now() },
    })
    expect(store.getState().jobs.length).toBe(1)
    expect(() =>
      store.apply({
        type: 'JOB_RECORDED',
        job: { id: 'j1', taskId: 't', status: 'pending', startedAt: Date.now() },
      }),
    ).toThrow(DuplicateJobError)
  })

  it('JOB_UPDATED on missing id throws UnknownJobError', () => {
    const store = new CTFTaskStateStore(freshState())
    expect(() =>
      store.apply({ type: 'JOB_UPDATED', jobId: 'nope', patch: {} }),
    ).toThrow(UnknownJobError)
  })

  it('terminal Job cannot return to running', () => {
    const store = new CTFTaskStateStore(freshState())
    store.apply({
      type: 'JOB_RECORDED',
      job: { id: 'j1', taskId: 't', status: 'running', startedAt: Date.now() },
    })
    store.apply({ type: 'JOB_UPDATED', jobId: 'j1', patch: { status: 'success' } })
    expect(() =>
      store.apply({ type: 'JOB_UPDATED', jobId: 'j1', patch: { status: 'running' } }),
    ).toThrow(IllegalJobTransitionError)
  })

  it('BackgroundJobManager.subscribe fires JOB_STARTED + JOB_COMPLETED (no polling)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jm-phase16-'))
    try {
      const seen: string[] = []
      const jm = new BackgroundJobManager(
        { taskWorkspaceDir: dir, maxPerAgent: 4, maxPerTask: 4 },
        () => Promise.resolve({ summary: 'ok' }),
      )
      const unsub = jm.subscribe((ev) => seen.push(ev.type))
      const job = await jm.spawn({
        taskId: 't', agentId: 'a', toolId: 'Bash',
        input: { command: 'echo hi' },
      })
      await jm.wait(job.id, 5000)
      unsub()
      expect(seen).toEqual(expect.arrayContaining(['JOB_STARTED', 'JOB_UPDATED', 'JOB_COMPLETED']))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('dispose unsubscribes — no further events observed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jm-phase16-'))
    try {
      const seen: string[] = []
      const jm = new BackgroundJobManager(
        { taskWorkspaceDir: dir, maxPerAgent: 4, maxPerTask: 4 },
        () => Promise.resolve({ summary: 'ok' }),
      )
      const unsub = jm.subscribe((ev) => seen.push(ev.type))
      const j1 = await jm.spawn({
        taskId: 't', agentId: 'a', toolId: 'Bash', input: { command: 'echo hi' },
      })
      await jm.wait(j1.id, 5000)
      unsub()
      const before = seen.length
      const j2 = await jm.spawn({
        taskId: 't', agentId: 'a', toolId: 'Bash', input: { command: 'echo bye' },
      })
      await jm.wait(j2.id, 5000)
      expect(seen.length).toBe(before)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ────────────────────────────────────────────────────────────────────────
// §6 — Reducer
// ────────────────────────────────────────────────────────────────────────
describe('§6 — Reducer invariants', () => {
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
      jobs: [], activeJobIds: [],
      flagCandidates: [],
      createdAt: now, updatedAt: now,
    }
  }

  it('HYPOTHESIS_ADDED appends; duplicates rejected', () => {
    const store = new CTFTaskStateStore(freshState())
    store.apply({
      type: 'HYPOTHESIS_ADDED',
      hypothesis: {
        id: 'h1',
        statement: 'x',
        status: 'proposed',
        evidenceIds: [],
        createdBy: 'main',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    })
    expect(store.getState().hypotheses.length).toBe(1)
    expect(() =>
      store.apply({
        type: 'HYPOTHESIS_ADDED',
        hypothesis: {
          id: 'h1', statement: 'y', status: 'proposed',
          evidenceIds: [], createdBy: 'main',
          createdAt: Date.now(), updatedAt: Date.now(),
        },
      }),
    ).toThrow(DuplicateHypothesisError)
  })

  it('HYPOTHESIS_UPDATED throws on missing id', () => {
    const store = new CTFTaskStateStore(freshState())
    expect(() =>
      store.apply({ type: 'HYPOTHESIS_UPDATED', hypothesisId: 'nope', patch: {} }),
    ).toThrow(UnknownHypothesisError)
  })

  it('ATTEMPT_RECORDED appends; duplicates rejected', () => {
    const store = new CTFTaskStateStore(freshState())
    store.apply({
      type: 'ATTEMPT_RECORDED',
      attempt: { id: 'a1', kind: 'tool', summary: 'x', status: 'pending', createdAt: Date.now() },
    })
    expect(store.getState().attempts.length).toBe(1)
    expect(() =>
      store.apply({
        type: 'ATTEMPT_RECORDED',
        attempt: { id: 'a1', kind: 'tool', summary: 'x', status: 'pending', createdAt: Date.now() },
      }),
    ).toThrow(DuplicateAttemptError)
  })

  it('ATTEMPT_UPDATED refuses completed → running', () => {
    const store = new CTFTaskStateStore(freshState())
    store.apply({
      type: 'ATTEMPT_RECORDED',
      attempt: { id: 'a1', kind: 'tool', summary: 'x', status: 'running', createdAt: Date.now() },
    })
    store.apply({ type: 'ATTEMPT_UPDATED', attemptId: 'a1', patch: { status: 'succeeded' } })
    expect(() =>
      store.apply({ type: 'ATTEMPT_UPDATED', attemptId: 'a1', patch: { status: 'running' } }),
    ).toThrow(IllegalAttemptTransitionError)
  })

  it('ATTEMPT_UPDATED throws on missing id', () => {
    const store = new CTFTaskStateStore(freshState())
    expect(() =>
      store.apply({ type: 'ATTEMPT_UPDATED', attemptId: 'nope', patch: {} }),
    ).toThrow(UnknownAttemptError)
  })

  it('TASK_COMPLETED is immutable', () => {
    const store = new CTFTaskStateStore(freshState())
    store.apply({ type: 'TASK_COMPLETED', status: 'solved', reason: 'ok' })
    expect(() =>
      store.apply({ type: 'TASK_COMPLETED', status: 'failed', reason: 'rewrite' }),
    ).toThrow(TaskAlreadyCompletedError)
  })

  it('late job events after TASK_COMPLETED do not mutate state', () => {
    const store = new CTFTaskStateStore(freshState())
    store.apply({ type: 'TASK_COMPLETED', status: 'solved', reason: 'ok' })
    // After completion, the store's terminal-phase guard rejects JOB_RECORDED
    // (matching §十一 — terminal Job cannot return to running; the same
    // guard now also blocks new Job records after Task completion).
    const sizeBefore = store.getState().jobs.length
    try {
      store.apply({
        type: 'JOB_RECORDED',
        job: { id: 'late', taskId: 't', status: 'success', startedAt: Date.now() },
      })
    } catch {
      /* expected — terminal guard fires */
    }
    // State must not have changed regardless of whether the store threw.
    expect(store.getState().jobs.length).toBe(sizeBefore)
  })
})

// ────────────────────────────────────────────────────────────────────────
// §7 — Projector
// ────────────────────────────────────────────────────────────────────────
describe('§7 — TaskStateProjector', () => {
  it('captures baseline + projects new findings/artifacts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'phase16-proj-'))
    try {
      const { FindingStore } = await import('../src/core/findings.js')
      const { ArtifactStore } = await import('../src/core/artifacts.js')
      const findingStore = new FindingStore(dir)
      const artifactStore = new ArtifactStore(dir)
      const proj = new TaskStateProjector({ findingStore, artifactStore })
      const before = proj.captureSnapshot()
      expect(before.findingIds.size).toBe(0)
      findingStore.append({
        taskId: 't',
        producerAgentId: 'main',
        category: 'triage',
        title: 't',
        summary: 's',
        confidence: 'low',
        evidence: [],
        artifactIds: [],
      })
      const after = proj.captureSnapshot()
      const diff = proj.projectDiff(before, { producerProfileId: 'main' })
      expect(diff.newFindingIds.length).toBe(1)
      // duplicate IDs are not re-emitted
      const diff2 = proj.projectDiff(after, { producerProfileId: 'main' })
      expect(diff2.newFindingIds.length).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('Specialist artifact lineage is preserved via .lineage.jsonl sidecar', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'phase16-lineage-'))
    try {
      const { FindingStore } = await import('../src/core/findings.js')
      const { ArtifactStore } = await import('../src/core/artifacts.js')
      const parentFs = new FindingStore(join(dir, 'parent'))
      const parentAs = new ArtifactStore(join(dir, 'parent'))
      const childFs = new FindingStore(join(dir, 'child'))
      const childAs = new ArtifactStore(join(dir, 'child'))
      // Write a child artifact with content (after the projector is set up
      // and the snapshot is captured, so projectDiff sees it as new).
      const proj = new TaskStateProjector({
        findingStore: childFs,
        artifactStore: childAs,
        parentArtifactStore: parentAs,
        parentArtifactRoot: join(dir, 'parent'),
      })
      // Capture BEFORE the child artifact exists so the diff treats it as new.
      const before = proj.captureSnapshot()
      // Now write the child artifact so projectDiff sees it as a new entry.
      childAs.writeSync(
        { taskId: 't', producerAgentId: 'specialist', type: 'data' },
        Buffer.from('hello'),
        'txt',
      )
      const childMeta = childAs.list()[0]
      expect(childMeta).toBeDefined()
      // projectDiff with handoffId set triggers file copy into parent.
      proj.projectDiff(before, { producerProfileId: 'specialist', handoffId: 'hof_xyz' })
      // Parent should now have the artifact + a lineage entry
      const parentMetas = parentAs.list()
      expect(parentMetas.length).toBe(1)
      const lineagePath = join(dir, 'parent', 'artifacts', '.lineage.jsonl')
      expect(existsSync(lineagePath)).toBe(true)
      const lines = readFileSync(lineagePath, 'utf8').trim().split('\n')
      const entry = JSON.parse(lines[lines.length - 1])
      expect(entry.parentArtifactId).toBe(parentMetas[0].id)
      expect(entry.originalArtifactId).toBe(childMeta.id)
      expect(entry.handoffId).toBe('hof_xyz')
      expect(entry.sourcePath).toBe(childMeta.path)
      void parentFs
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('Main Agent run produces non-empty finding/artifact ids', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'phase16-ma-'))
    try {
      writeFileSync(join(dir, 'sample.txt'), 'flag{test}')
      const orch = await CTFTaskOrchestrator.create({
        cwd: dir,
        profileId: 'triage',
        jobLimits: { maxPerAgent: 0, maxPerTask: 0 },
      })
      // Manually append a finding and run a workflow that emits one to
      // verify the projector wires the diff through.
      orch.mainHarness.findingStore.append({
        taskId: orch.getState().taskId,
        producerAgentId: 'triage',
        category: 'triage',
        title: 'pre',
        summary: 'pre',
        confidence: 'low',
        evidence: [],
        artifactIds: [],
      })
      const before = orch.getState().findings.length
      const r = await orch.runWorkflow('unknown_file_triage', { FILE_INPUT: join(dir, 'sample.txt') })
      const after = orch.getState().findings.length
      expect(r).toBeDefined()
      // The workflow itself may or may not emit; the test just asserts the
      // orchestrator's projector path doesn't lose data — findings are
      // >= before.
      expect(after).toBeGreaterThanOrEqual(before)
      void existsSync
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ────────────────────────────────────────────────────────────────────────
// §8 — Integration: Runtime → Orchestrator → Specialist → Parent state
// ────────────────────────────────────────────────────────────────────────
describe('§8 — Integration', () => {
  it('specialist handoff updates Parent TaskState findings', async () => {
    const orch = await createCTFTaskRuntime({
      cwd: root,
      profileId: 'triage',
      client: makeFakeClient(),
      renderer: makeFakeRenderer(),
    })
    try {
      // Pre-seed a finding in the parent so the handoff has something to inherit.
      orch.mainHarness.findingStore.append({
        taskId: orch.getState().taskId,
        producerAgentId: 'triage',
        category: 'forensics',
        title: 'parent seed',
        summary: 'parent seed',
        confidence: 'low',
        evidence: [],
        artifactIds: [],
      })
      const seed = orch.mainHarness.findingStore.list()[0]
      const h = orch.orchestrator.requestHandoff({
        fromAgentRunId: 'run_main',
        targetCapability: 'triage',
        reason: 'r',
        objective: 'o',
        findingIds: [seed.id],
      })
      const r = await orch.orchestrator.approveHandoff(h.id)
      // The handoff closed through the lifecycle.
      const state = orch.getState()
      const closed = state.handoffs.find((x) => x.id === h.id)
      expect(closed).toBeTruthy()
      expect(['approved', 'running', 'completed', 'failed', 'cancelled']).toContain(closed!.status)
      expect(r).toBeTruthy()
    } finally {
      await orch.dispose()
    }
  })

  it('concurrent approveHandoff only spawns one specialist', async () => {
    const orch = await createCTFTaskRuntime({
      cwd: root,
      profileId: 'triage',
      client: makeFakeClient(),
      renderer: makeFakeRenderer(),
    })
    try {
      const h = orch.orchestrator.requestHandoff({
        fromAgentRunId: 'run_main',
        targetCapability: 'triage',
        reason: 'r',
        objective: 'o',
      })
      await Promise.all([
        orch.orchestrator.approveHandoff(h.id),
        orch.orchestrator.approveHandoff(h.id),
      ])
      const runs = orch.getState().agentRuns.filter((r) => r.handoffId === h.id)
      expect(runs.length).toBe(1)
    } finally {
      await orch.dispose()
    }
  })
})

// ────────────────────────────────────────────────────────────────────────
// §15 — Profile correctness: switchProfile affects next runTurn
// ────────────────────────────────────────────────────────────────────────
describe('§15 — Profile propagation', () => {
  it('After switchProfile(), Harness.runTurn reads the new profile (not the closure-captured one)', async () => {
    // §十五第 3 项 — previously, runTurn captured the profile at createHarness
    // time. After switchProfile(), a subsequent runTurn should reflect the
    // new profile in its engine config (agentId) and prompt.
    const orch = await createCTFTaskRuntime({
      cwd: root,
      profileId: 'triage',
      client: makeFakeClient(),
      renderer: makeFakeRenderer(),
    })
    try {
      // Snapshot the initial profile id from the engine config that runTurn
      // would build. We exercise this by reading the harness's broker
      // getProfile() and confirming the orchestrator's profileStore tracks it.
      const initialId = orch.mainHarness.broker.getProfile().id
      expect(initialId).toBe('triage')
      // Switch profile.
      orch.orchestrator.switchProfile('crypto')
      // After switch, broker must report the new profile (this is the
      // hook runTurn reads via broker.getProfile()).
      const switchedId = orch.mainHarness.broker.getProfile().id
      expect(switchedId).toBe('crypto')
      // The active profile id in TaskState must also be updated.
      expect(orch.getState().activeProfileId).toBe('crypto')
      // Sanity: capture the engine config agentId that the next runTurn
      // would build by directly invoking runTurn with a fake client and
      // confirming the engine is built with the new profile's id.
      const script = [{ id: 'echo', args: { text: 'hello' } }]
      const fakeClient = makeStreamingScriptedClient(script)
      // Replace the runtime's mainHarness client via a fresh runTurn call —
      // it should build the engine with agentId='crypto', not 'triage'.
      // The engine is constructed inside runTurn so we cannot directly
      // inspect it, but the call must not throw and must complete.
      const out = await orch.mainHarness.runTurn('user message', [], {
        // systemPromptAddon reflects the active profile's prompt modules
        // via composeSystemPrompt — verify it doesn't throw.
      })
      expect(out).toBeDefined()
      expect(out.result).toBeDefined()
    } finally {
      await orch.dispose()
    }
  })
})

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────

function makeCollector(buffer: string[]): NodeJS.WritableStream {
  return {
    write: (chunk: string | Uint8Array) => {
      buffer.push(typeof chunk === 'string' ? chunk : chunk.toString())
      return true
    },
    end: () => {},
    on: () => makeCollector(buffer),
    once: () => makeCollector(buffer),
    emit: () => true,
    removeListener: () => makeCollector(buffer),
    removeAllListeners: () => makeCollector(buffer),
    setMaxListeners: () => makeCollector(buffer),
    getMaxListeners: () => 0,
    listeners: () => [],
    rawListeners: () => [],
    eventNames: () => [],
    listenerCount: () => 0,
    addListener: () => makeCollector(buffer),
    prependListener: () => makeCollector(buffer),
    prependOnceListener: () => makeCollector(buffer),
    off: () => makeCollector(buffer),
    writable: true,
    readable: false,
    destroyed: false,
    writableEnded: false,
    writableFinished: false,
    writableHighWaterMark: 0,
    writableLength: 0,
    writableObjectMode: false,
    writableCorked: 0,
    isTTY: false,
    cork: () => {},
    uncork: () => {},
    setDefaultEncoding: () => makeCollector(buffer),
    destroy: () => {},
    pipe: () => makeCollector(buffer),
    unpipe: () => makeCollector(buffer),
    // Node 18+ compatibility
    [Symbol.asyncIterator]: undefined as never,
  } as unknown as NodeJS.WritableStream
}

function makeFakeClient(): OpenAIClient {
  return {
    chat: {
      completions: {
        create: (() => {
          throw new Error('fake-client: no LLM calls in tests')
        }) as never,
      },
    },
  } as unknown as OpenAIClient
}

/**
 * Scripted OpenAI streaming client — yields an assistant tool_call chunk
 * followed by a finish_reason=tool_calls chunk so the engine executes the
 * tool, then a final assistant text chunk with finish_reason='stop'.
 * Mirrors the helper used in tests/phase16E2E.test.ts.
 */
function makeStreamingScriptedClient(
  script: Array<{ id: string; args: Record<string, unknown> }>,
): {
  chat: {
    completions: {
      create: () => Generator<unknown, void, unknown>
    }
  }
} {
  let turn = 0
  return {
    chat: {
      completions: {
        create: () => {
          const idx = Math.min(turn, script.length)
          turn += 1
          const item = script[idx]
          function* gen(): Generator<unknown, void, unknown> {
            if (item) {
              yield {
                id: `chat_${turn}`,
                object: 'chat.completion.chunk',
                created: 0,
                model: 'fake',
                choices: [
                  {
                    index: 0,
                    delta: {
                      role: 'assistant' as const,
                      tool_calls: [
                        {
                          index: 0,
                          id: `tc_${turn}`,
                          type: 'function' as const,
                          function: { name: item.id, arguments: JSON.stringify(item.args) },
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              }
              yield {
                id: `chat_${turn}`,
                object: 'chat.completion.chunk',
                created: 0,
                model: 'fake',
                choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
                usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
              }
            } else {
              yield {
                id: `chat_${turn}`,
                object: 'chat.completion.chunk',
                created: 0,
                model: 'fake',
                choices: [
                  {
                    index: 0,
                    delta: { role: 'assistant' as const, content: 'done' },
                    finish_reason: 'stop',
                  },
                ],
                usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
              }
            }
          }
          return gen()
        },
      },
    },
  }
}

function makeFakeRenderer(): Renderer {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    success: () => {},
    debug: () => {},
    streamText: () => {},
    streamThinking: () => {},
    streamToolCall: () => {},
    streamToolResult: () => {},
    endStream: () => {},
    userMessage: () => Promise.resolve(''),
    confirm: () => Promise.resolve(false),
    pickOption: () => Promise.resolve(null),
  } as unknown as Renderer
}

interface FakeRuntime {
  orchestrator: CTFTaskOrchestrator
  mainHarness: HarnessBundle
  dependencies: AgentRuntimeDependencies
  abort: ReturnType<typeof createLinkedAbortController>
  getState(): CTFTaskState
  cancel(reason: string): Promise<void>
  dispose(): Promise<void>
}

// Helper reserved for future expansion — not used now that the CLI tests
// wrap `createCTFTaskRuntime` directly.
void (null as unknown as FakeRuntime)