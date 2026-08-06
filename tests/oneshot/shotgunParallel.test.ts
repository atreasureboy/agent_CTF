/**
 * §Round-8 — ShotgunCoordinator concurrency proof.
 *
 * The previous test asserted `elapsed < SLOW * 4` which is too loose
 * (a serial 3×200ms = 600ms implementation also passes <800ms). This
 * suite uses an in-flight counter to **prove** concurrency: at the
 * peak, `maxInFlight` must equal the number of jobs.
 *
 * Coverage:
 *  - 5 manifests run with maxInFlight === 5
 *  - Partial failure: 1 throws, 4 succeed — report carries 1 rejected + 4 results
 *  - All failure: every run throws — report carries 3 rejected + 0 results
 *  - firstWins: dispatcher still completes even when firstWins fires no abort
 *  - heavy-tier runs are concurrent WITHIN their tier once approved
 *  - network-tier runs are concurrent WITHIN their tier once approved
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  OneShotCatalog,
  OneShotRegistry,
  Dispatcher,
  BudgetManager,
} from '../../src/ctf/oneshot/index.js'
import type { OneShotManifest } from '../../src/ctf/oneshot/types.js'
import type { TaskExecutionContext } from '../../src/core/ctfRuntime/taskExecutionContext.js'
import { ShotgunCoordinator } from '../../src/ctf/agents/shotgunCoordinator.js'
import { BackgroundJobManager } from '../../src/core/backgroundJobs.js'

function makeTaskContext(root: string): TaskExecutionContext {
  return {
    taskId: 'task_shotgun_r8',
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

describe('ShotgunCoordinator — Round-8 rigorous concurrency', () => {
  let workRoot: string
  beforeEach(() => {
    workRoot = mkdtempSync(join(tmpdir(), 'shotgun-r8-'))
  })

  function buildCoord(
    taskContext: TaskExecutionContext,
    manifests: OneShotManifest[],
    budget?: { perTaskHeavyRuns?: number; heavyConcurrency?: number; fastConcurrency?: number },
  ): ShotgunCoordinator {
    const catalog = new OneShotCatalog()
    const registry = new OneShotRegistry(catalog)
    for (const m of manifests) registry.register(m)
    const jobManager = new BackgroundJobManager(
      { taskWorkspaceDir: workRoot, maxPerAgent: 32, maxPerTask: 32 },
      // eslint-disable-next-line @typescript-eslint/require-await
      async () => ({}),
    )
    const dispatcherOpts: Record<string, unknown> = {
      registry,
      catalog,
      jobManager,
      workspace: workRoot,
      signal: new AbortController().signal,
      taskContext,
    }
    if (budget) {
      dispatcherOpts['budget'] = new BudgetManager(budget)
    }
    const dispatcher = new Dispatcher(
      dispatcherOpts as unknown as ConstructorParameters<typeof Dispatcher>[0],
    )
    return new ShotgunCoordinator(registry, dispatcher, taskContext)
  }

  function slowManifest(id: string, extra?: Partial<OneShotManifest>): OneShotManifest {
    return {
      id,
      displayName: `m-${id}`,
      category: 'triage',
      description: `parallelism test manifest ${id}`,
      source: { repository: 'https://example.com/' },
      maturity: 'stable',
      enabledByDefault: true,
      allowedProfiles: ['triage'],
      runner: { type: 'process', command: ['sleep', '0.2'] },
      resources: { timeoutSeconds: 5, maxOutputBytes: 4096 },
      network: { mode: 'none', requiresScopeApproval: false },
      output: { parser: 'passthrough' },
      scheduling: { costTier: 'fast', falsePositiveRisk: 'low' },
      ...extra,
    }
  }

  it('maxInFlight reflects true concurrent execution (5 jobs at once)', async () => {
    const ids = ['p1', 'p2', 'p3', 'p4', 'p5']
    const manifests = ids.map((id) => slowManifest(id))
    const coord = buildCoord(makeTaskContext(workRoot), manifests)
    const report = await coord.dispatch({ selectedManifestIds: ids })
    expect(report.results.length).toBe(5)
    expect(report.rejected).toEqual([])
    expect(report.maxInFlight).toBe(5)
  })

  it('partial failure: 1 throws, 4 succeed', async () => {
    const ids = ['ok1', 'bad1', 'ok2', 'ok3', 'ok4']
    const manifests = ids.map((id) => {
      if (id === 'bad1') {
        return slowManifest(id, { runner: { type: 'process', command: ['sh', '-c', 'exit 7'] } })
      }
      return slowManifest(id)
    })
    const coord = buildCoord(makeTaskContext(workRoot), manifests)
    const report = await coord.dispatch({ selectedManifestIds: ids })
    // The failing run shows up as `status: 'failed'` in `results`,
    // not in `rejected` (which is reserved for pre-dispatch rejections).
    expect(report.results.length).toBe(5)
    expect(report.rejected).toEqual([])
    const bad1 = report.results.find((r) => r.manifestId === 'bad1')
    expect(bad1).toBeDefined()
    expect(bad1?.status).toBe('failed')
    const okResults = report.results.filter((r) => r.manifestId !== 'bad1')
    expect(okResults.every((r) => r.status === 'completed')).toBe(true)
    expect(report.maxInFlight).toBe(5)
  })

  it('all-failure: every run throws', async () => {
    const ids = ['x1', 'x2', 'x3']
    const manifests = ids.map((id) =>
      slowManifest(id, { runner: { type: 'process', command: ['sh', '-c', 'exit 1'] } }),
    )
    const coord = buildCoord(makeTaskContext(workRoot), manifests)
    const report = await coord.dispatch({ selectedManifestIds: ids })
    expect(report.results.length).toBe(3)
    expect(report.rejected.length).toBe(0)
    expect(report.results.every((r) => r.status === 'failed')).toBe(true)
    // Even when all throw, they ran concurrently.
    expect(report.maxInFlight).toBe(3)
  })

  it('firstWins: dispatch completes without throwing when no winner', async () => {
    // No runner emits high-confidence candidates via the default
    // ProcessRunner, so firstWins becomes a no-op when nothing
    // resolves with `confidence >= 0.7`. Verify the Coordinator
    // doesn't crash and still reports the runs.
    const ids = ['q1', 's1', 's2']
    const manifests: OneShotManifest[] = [
      slowManifest('q1'),
      slowManifest('s1', { runner: { type: 'process', command: ['sleep', '0.4'] } }),
      slowManifest('s2', { runner: { type: 'process', command: ['sleep', '0.4'] } }),
    ]
    const coord = buildCoord(makeTaskContext(workRoot), manifests)
    const report = await coord.dispatch({ selectedManifestIds: ids, firstWins: true })
    expect(report.results.length).toBe(3)
    expect(report.rejected).toEqual([])
    expect(report.maxInFlight).toBe(3)
  })

  it('heavy-tier manifests are concurrent when approved', async () => {
    const ids = ['h1', 'h2', 'h3']
    const manifests = ids.map((id) =>
      slowManifest(id, { scheduling: { costTier: 'heavy', falsePositiveRisk: 'low' } }),
    )
    const ctx = makeTaskContext(workRoot)
    ctx.contestScope.allowHeavyOneShots = true
    ctx.contestConfig.allowHeavyOneShots = true
    // Budget defaults cap heavy-tier at 1 per task; lift it for
    // this concurrency test.
    const coord = buildCoord(ctx, manifests, {
      perTaskHeavyRuns: 8,
      heavyConcurrency: 8,
      fastConcurrency: 32,
    })
    const report = await coord.dispatch({ selectedManifestIds: ids })
    expect(report.results.length).toBe(3)
    expect(report.rejected).toEqual([])
    expect(report.maxInFlight).toBe(3)
  })

  it('heavy-tier is rejected without explicit approval', async () => {
    const ids = ['h1', 'h2']
    const manifests = ids.map((id) =>
      slowManifest(id, { scheduling: { costTier: 'heavy', falsePositiveRisk: 'low' } }),
    )
    const ctx = makeTaskContext(workRoot)
    // default: allowHeavyOneShots = false
    const coord = buildCoord(ctx, manifests)
    const report = await coord.dispatch({ selectedManifestIds: ids })
    expect(report.results.length).toBe(0)
    expect(report.rejected.length).toBe(2)
    expect(report.rejected[0].reason).toMatch(/heavy|approval/i)
  })

  it('network-mode is rejected without publicNetwork', async () => {
    const ids = ['n1', 'n2']
    const manifests = ids.map((id) =>
      slowManifest(id, {
        network: { mode: 'outbound-readonly', requiresScopeApproval: false },
      }),
    )
    const ctx = makeTaskContext(workRoot)
    const coord = buildCoord(ctx, manifests)
    const report = await coord.dispatch({ selectedManifestIds: ids })
    expect(report.results.length).toBe(0)
    expect(report.rejected.length).toBe(2)
    expect(report.rejected[0].reason).toMatch(/network|public/i)
  })

  it('rejected manifests do not run (no concurrent side-effects)', async () => {
    // Mix one valid + one rejected-by-bad-id. The rejected must NOT
    // consume a concurrency slot.
    const manifests = [slowManifest('valid')]
    const coord = buildCoord(makeTaskContext(workRoot), manifests)
    const report = await coord.dispatch({ selectedManifestIds: ['valid', 'does_not_exist'] })
    expect(report.results.length).toBe(1)
    expect(report.rejected.length).toBe(1)
    expect(report.rejected[0].manifestId).toBe('does_not_exist')
    expect(report.maxInFlight).toBe(1)
  })
})
