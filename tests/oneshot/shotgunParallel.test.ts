/**
 * §Round-7 — prove ShotgunCoordinator actually fires manifests in
 * parallel rather than sequentially (the previous implementation
 * walked `selectedManifestIds` with `for (const id of …) await
 * runOne(...)` which serialised everything).
 *
 * Strategy: register 3 manifests that each sleep ~200ms via a custom
 * runner. Time a parallel dispatch — wall-clock must be <600ms (≤3×
 * the slowest single run) instead of ≥600ms (3× sequential).
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  OneShotCatalog,
  OneShotRegistry,
  Dispatcher,
  HealthChecker,
} from '../../src/ctf/oneshot/index.js'
import type { OneShotManifest, OneShotRunner } from '../../src/ctf/oneshot/manifestSchema.js'
import type { TaskExecutionContext } from '../../src/core/ctfRuntime/taskExecutionContext.js'
import { ShotgunCoordinator } from '../../src/ctf/agents/shotgunCoordinator.js'
import { BackgroundJobManager } from '../../src/core/backgroundJobs.js'

const SLOW = 200

function makeTaskContext(root: string): TaskExecutionContext {
  return {
    taskId: 'task_shotgun',
    workspaceDir: root,
    sessionDir: root,
    artifactDir: `${root}/artifacts`,
    inputDir: `${root}/input`,
    eventsFile: `${root}/events.ndjson`,
    profileId: 'triage',
    contestScope: {
      allowedFilesRoot: root,
      allowPublicNetwork: false,
      allowHeavyOneShots: false,
    },
    contestConfig: { allowedFilesRoot: root, allowPublicNetwork: false, allowHeavyOneShots: false },
    environment: {},
    abortSignal: new AbortController().signal,
    metadata: {},
  }
}

function slowManifest(id: string): OneShotManifest {
  const runner: OneShotRunner = {
    type: 'process',
    command: ['sleep', `${SLOW / 1000}`],
  }
  return {
    id,
    displayName: `slow-${id}`,
    category: 'triage',
    description: 'sleep for parallelism test',
    source: { repository: 'https://example.com/' },
    maturity: 'stable',
    enabledByDefault: true,
    allowedProfiles: ['triage'],
    runner,
    resources: { timeoutSeconds: 5, maxOutputBytes: 4096 },
    network: { mode: 'none', requiresScopeApproval: false },
    output: { parser: 'passthrough' },
    scheduling: { costTier: 'fast', falsePositiveRisk: 'low' },
  }
}

describe('ShotgunCoordinator parallel dispatch', () => {
  let workRoot: string
  beforeEach(() => {
    workRoot = mkdtempSync(join(tmpdir(), 'shotgun-parallel-'))
  })

  it('runs multiple READY manifests concurrently, not sequentially', async () => {
    const catalog = new OneShotCatalog()
    const registry = new OneShotRegistry(catalog)
    registry.register(slowManifest('a'))
    registry.register(slowManifest('b'))
    registry.register(slowManifest('c'))

    const jobManager = new BackgroundJobManager(
      { taskWorkspaceDir: workRoot },
      // eslint-disable-next-line @typescript-eslint/require-await
      async () => ({}),
    )
    const taskContext = makeTaskContext(workRoot)
    const dispatcher = new Dispatcher({
      registry,
      catalog,
      jobManager,
      workspace: workRoot,
      signal: new AbortController().signal,
      taskContext,
    })

    const coordinator = new ShotgunCoordinator(registry, dispatcher, taskContext)

    const start = Date.now()
    const report = await coordinator.dispatch({
      selectedManifestIds: ['a', 'b', 'c'],
      reason: 'parallelism-test',
    })
    const elapsed = Date.now() - start

    // Serial = 3 × SLOW = 600ms. Parallel should be ≈ SLOW = 200ms
    // (with a generous 4× margin for CI scheduling jitter).
    expect(elapsed).toBeLessThan(SLOW * 4)
    expect(report.results.length).toBe(3)
    expect(report.rejected).toEqual([])
  })
})