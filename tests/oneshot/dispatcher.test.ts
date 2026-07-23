import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  OneShotCatalog,
  OneShotRegistry,
  Dispatcher,
  BudgetManager,
  setRunnerOverride,
  clearRunnerOverrides,
} from '../../src/ctf/oneshot/index.js'
import { BackgroundJobManager } from '../../src/core/backgroundJobs.js'
import type { OneShotRunner, RunnerInputs } from '../../src/ctf/oneshot/index.js'
import type { OneShotManifest, OneShotResult } from '../../src/ctf/oneshot/index.js'
import type { TaskExecutionContext } from '../../src/core/ctfRuntime/taskExecutionContext.js'

function fakeRunner(behavior: (m: OneShotManifest, argv: string[]) => Promise<OneShotResult>): OneShotRunner {
  return {
    async run(_m: OneShotManifest, inputs: RunnerInputs): Promise<OneShotResult> {
      return behavior(_m, inputs.argv)
    },
  }
}

const baseManifest: OneShotManifest = {
  id: 'demo',
  displayName: 'Demo',
  category: 'demo',
  description: 'd',
  source: { repository: 'https://example.com/r' },
  maturity: 'stable',
  enabledByDefault: true,
  allowedProfiles: ['triage'],
  runner: { type: 'process', command: ['demo'] },
  resources: { timeoutSeconds: 10, maxOutputBytes: 1024 },
  network: { mode: 'none', requiresScopeApproval: false },
  output: { parser: 'passthrough' },
  scheduling: { costTier: 'fast', falsePositiveRisk: 'low' },
}

function makeTaskContext(workRoot: string): TaskExecutionContext {
  return {
    taskId: 'task_test123',
    workspaceDir: workRoot,
    sessionDir: workRoot,
    artifactDir: `${workRoot}/artifacts`,
    inputDir: `${workRoot}/input`,
    eventsFile: `${workRoot}/events.ndjson`,
    profileId: 'triage',
    contestScope: {
      allowedFilesRoot: workRoot,
      allowPublicNetwork: false,
      allowHeavyOneShots: false,
    },
    contestConfig: { allowedFilesRoot: workRoot, allowPublicNetwork: false, allowHeavyOneShots: false },
    environment: {},
    abortSignal: new AbortController().signal,
    metadata: {},
  }
}

describe('Dispatcher', () => {
  let workRoot: string
  let registry: OneShotRegistry
  let catalog: OneShotCatalog
  let jobManager: BackgroundJobManager
  let dispatcher: Dispatcher
  let taskContext: TaskExecutionContext

  beforeEach(() => {
    workRoot = mkdtempSync(join(tmpdir(), 'oneshot-dis-'))
    catalog = new OneShotCatalog()
    registry = new OneShotRegistry(catalog)
    jobManager = new BackgroundJobManager(
      { taskWorkspaceDir: workRoot },
      async () => ({}),
    )
    taskContext = makeTaskContext(workRoot)
    dispatcher = new Dispatcher({
      registry,
      catalog,
      jobManager,
      workspace: workRoot,
      signal: taskContext.abortSignal ?? new AbortController().signal,
      budget: new BudgetManager(),
      taskContext,
    })
    clearRunnerOverrides()
  })
  afterEachCleanup()

  function afterEachCleanup() {
    return () => {
      clearRunnerOverrides()
      rmSync(workRoot, { recursive: true, force: true })
    }
  }

  it('runs a single manifest and applies overrides', async () => {
    registry.register(baseManifest)
    setRunnerOverride('demo', fakeRunner(async () => ({
      runId: 'osp_over',
      manifestId: 'demo',
      taskId: 'task_test123',
      status: 'completed',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      findings: [],
      artifacts: [],
      candidates: [{ value: 'flag{ok}', sourceRuns: [], sourceArtifacts: [], confidence: 0.8, needsVerification: true }],
      diagnostics: { truncated: false, parserWarnings: [] },
      confidence: 0.8,
      falsePositiveRisk: 'low',
      summary: 'ok',
    })))
    const out = await dispatcher.runOne('demo', {
      argv: [],
      evidenceRoot: workRoot,
    })
    expect(out.status).toBe('completed')
    expect(out.candidates).toHaveLength(1)
    expect(out.taskId).toBe('task_test123')
  })

  it('emits ONESHOT projection events', async () => {
    registry.register(baseManifest)
    const seen: string[] = []
    dispatcher.addProjectionListener((e) => seen.push(e.type))
    setRunnerOverride('demo', fakeRunner(async () => ({
      runId: 'osp_e',
      manifestId: 'demo',
      taskId: 'task_test123',
      status: 'completed',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      findings: [{ category: 'c', title: 't', summary: 's', confidence: 'low' }],
      artifacts: [],
      candidates: [],
      diagnostics: { truncated: false, parserWarnings: [] },
      confidence: 0.5,
      falsePositiveRisk: 'low',
      summary: 'ok',
    })))
    await dispatcher.runOne('demo', {
      argv: [],
      evidenceRoot: workRoot,
    })
    expect(seen).toContain('ONESHOT_QUEUED')
    expect(seen).toContain('ONESHOT_STARTED')
    expect(seen).toContain('ONESHOT_COMPLETED')
  })

  it('throws unknown manifest', async () => {
    await expect(
      dispatcher.runOne('no-such', {
        argv: [],
        evidenceRoot: workRoot,
      }),
    ).rejects.toThrow(/unknown manifest/)
  })
})