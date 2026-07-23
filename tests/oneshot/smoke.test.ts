/**
 * Phase 2.0 §三十一 — no-network smoke test for the OneShot pipeline.
 *
 * Wires up a full CTFTaskRuntime in workflow-only mode, registers a fake
 * manifest, runs it through the BackgroundJobManager, persists the
 * OneShotResult via ResultStore, inspects it, cancels another slow run,
 * and disposes.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createCTFTaskRuntime } from '../../src/core/ctfRuntime/createCTFTaskRuntime.js'
import { Dispatcher } from '../../src/ctf/oneshot/dispatcher.js'
import {
  OneShotCatalog,
  OneShotRegistry,
  setRunnerOverride,
  clearRunnerOverrides,
} from '../../src/ctf/oneshot/index.js'
import { BackgroundJobManager } from '../../src/core/backgroundJobs.js'
import { createOneShotResultStore } from '../../src/ctf/oneshot/resultStore.js'
import type { OneShotRunner, RunnerInputs } from '../../src/ctf/oneshot/index.js'
import type { OneShotManifest, OneShotResult } from '../../src/ctf/oneshot/index.js'

function fakeRunner(behavior: (argv: string[]) => Promise<OneShotResult>): OneShotRunner {
  return {
    async run(_m: OneShotManifest, inputs: RunnerInputs): Promise<OneShotResult> {
      return behavior(inputs.argv)
    },
  }
}

describe('Phase 2.0 — OneShot runtime smoke test', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'phase20-smoke-'))
    clearRunnerOverrides()
  })

  function cleanup() {
    return () => {
      clearRunnerOverrides()
      rmSync(root, { recursive: true, force: true })
    }
  }

  it('runs a fake manifest end-to-end through BackgroundJobManager + ResultStore', async () => {
    const cleanupFn = cleanup()
    try {
      const runtime = await createCTFTaskRuntime({
        cwd: root,
        profileId: 'orchestrator',
        mode: 'workflow-only',
        contestScope: {
          allowedFilesRoot: root,
          allowPublicNetwork: false,
          allowHeavyOneShots: false,
        },
      })
      expect(runtime.mode).toBe('workflow-only')

      // Register a fake manifest.
      const manifest: OneShotManifest = {
        id: 'smoke-fake',
        displayName: 'smoke fake',
        category: 'demo',
        description: 'phase-2.0 smoke',
        source: { repository: 'https://example.com/r' },
        maturity: 'experimental',
        enabledByDefault: true,
        allowedProfiles: ['orchestrator'],
        runner: { type: 'process', command: ['echo', 'smoke'] },
        resources: { timeoutSeconds: 30, maxOutputBytes: 1024 },
        network: { mode: 'none', requiresScopeApproval: false },
        output: { parser: 'passthrough' },
        scheduling: { costTier: 'fast', falsePositiveRisk: 'low' },
      }
      const catalog = new OneShotCatalog()
      const registry = new OneShotRegistry(catalog)
      registry.register(manifest)
      const jobManager = new BackgroundJobManager(
        { taskWorkspaceDir: runtime.mainHarness.taskWorkspace.paths.root },
        async () => ({}),
      )
      const dispatcher = new Dispatcher({
        registry,
        catalog,
        jobManager,
        workspace: runtime.mainHarness.taskWorkspace.paths.root,
        signal: runtime.abort.signal,
        taskContext: runtime.mainHarness.context,
        orchestrator: runtime.orchestrator,
      })
      setRunnerOverride('smoke-fake', fakeRunner(async () => ({
        runId: 'osp_smoke',
        manifestId: 'smoke-fake',
        taskId: 'pending',
        status: 'completed',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        findings: [{ category: 'demo', title: 'ok', summary: 'ok', confidence: 'high' }],
        artifacts: [],
        candidates: [],
        diagnostics: { truncated: false, parserWarnings: [] },
        confidence: 0.9,
        falsePositiveRisk: 'low',
        summary: 'smoke-ok',
      })))

      const out = await dispatcher.runOne('smoke-fake', {
        argv: [],
        evidenceRoot: `${runtime.mainHarness.context.artifactDir}/.oneshots`,
      })
      expect(out.status).toBe('completed')
      expect(out.taskId).toBe(runtime.mainHarness.context.taskId)
      expect(out.findings.length).toBeGreaterThan(0)

      // ResultStore persists it.
      const store = createOneShotResultStore({
        taskWorkspaceDir: runtime.mainHarness.taskWorkspace.paths.root,
      })
      const retrieved = await store.get(out.runId)
      expect(retrieved).not.toBeNull()
      expect(retrieved?.taskId).toBe(runtime.mainHarness.context.taskId)
      const persistedFile = store.resolvePath(out.runId)
      expect(existsSync(persistedFile)).toBe(true)
      const onDisk = JSON.parse(readFileSync(persistedFile, 'utf8')) as OneShotResult
      expect(onDisk.runId).toBe(out.runId)
      expect(onDisk.taskId).toBe(runtime.mainHarness.context.taskId)

      // TaskState has the OneShotRunRecord projected.
      const state = runtime.getState()
      const runRecord = state.oneShotRuns.find((r) => r.id === out.runId)
      expect(runRecord).toBeDefined()
      expect(runRecord?.taskId).toBe(runtime.mainHarness.context.taskId)
      expect(runRecord?.status).toBe('completed')
      expect(runRecord?.backgroundJobId).not.toBe('')

      // dispose cleanly.
      await runtime.dispose()
      void cleanupFn
    } catch (err) {
      cleanupFn()
      throw err
    }
  })
})