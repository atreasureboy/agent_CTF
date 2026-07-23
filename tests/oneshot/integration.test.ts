import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  OneShotCatalog,
  OneShotRegistry,
  loadManifestsFromDir,
  Dispatcher,
  HealthChecker,
  formatDoctor,
  summarizeDoctor,
} from '../../src/ctf/oneshot/index.js'
import type { DoctorRow } from '../../src/ctf/oneshot/index.js'
import { BackgroundJobManager } from '../../src/core/backgroundJobs.js'
import type { TaskExecutionContext } from '../../src/core/ctfRuntime/taskExecutionContext.js'

function makeTaskContext(root: string): TaskExecutionContext {
  return {
    taskId: 'task_int123',
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

describe('oneshot integration', () => {
  let workRoot: string

  beforeEach(() => {
    workRoot = mkdtempSync(join(tmpdir(), 'oneshot-int-'))
  })

  it('loads bundled manifests and rejects malformed ones', () => {
    const catalog = new OneShotCatalog()
    const dir = join(process.cwd(), 'oneshot', 'manifests')
    const { accepted, invalid } = loadManifestsFromDir(dir, catalog)
    expect(accepted.length).toBeGreaterThan(5)
    // zsteg manifest should be loaded.
    expect(catalog.has('zsteg')).toBe(true)
    expect(catalog.has('rsactftool')).toBe(true)
    expect(invalid.every((inv) => !inv.file.endsWith('.json') || inv.error.length > 0)).toBe(true)
  })

  it('runs a registered ProcessRunner-backed manifest end-to-end', async () => {
    const catalog = new OneShotCatalog()
    const registry = new OneShotRegistry(catalog)
    // echo is a safe built-in; we still ship a runner that invokes /bin/echo.
    registry.register({
      id: 'echo',
      displayName: 'echo wrapper',
      category: 'triage',
      description: 'echoes input for tests',
      source: { repository: 'https://example.com/r' },
      maturity: 'stable',
      enabledByDefault: true,
      allowedProfiles: ['triage'],
      runner: { type: 'process', command: ['echo', 'hello'] },
      resources: { timeoutSeconds: 30, maxOutputBytes: 4096 },
      network: { mode: 'none', requiresScopeApproval: false },
      output: { parser: 'passthrough' },
      scheduling: { costTier: 'fast', falsePositiveRisk: 'low' },
    })
    const jobManager = new BackgroundJobManager(
      { taskWorkspaceDir: workRoot },
      async () => ({}),
    )
    const dispatcher = new Dispatcher({
      registry,
      catalog,
      jobManager,
      workspace: workRoot,
      signal: new AbortController().signal,
      taskContext: makeTaskContext(workRoot),
    })
    const result = await dispatcher.runOne('echo', {
      argv: [],
      evidenceRoot: workRoot,
    })
    expect(result.status).toBe('completed')
    expect(existsSync(result.diagnostics.stdoutPath ?? '')).toBe(true)
  })

  it('Doctor correctly reports status per manifest', async () => {
    const catalog = new OneShotCatalog()
    const registry = new OneShotRegistry(catalog)
    registry.register({
      id: 'ready-stable',
      displayName: 'Ready stable',
      category: 'a',
      description: 'd',
      source: { repository: 'https://example.com/r' },
      maturity: 'stable',
      enabledByDefault: true,
      allowedProfiles: ['a'],
      runner: { type: 'process', command: ['true'] },
      resources: { timeoutSeconds: 5, maxOutputBytes: 1024 },
      network: { mode: 'none', requiresScopeApproval: false },
      output: { parser: 'passthrough' },
      scheduling: { costTier: 'fast', falsePositiveRisk: 'low' },
    })
    registry.register({
      id: 'heavy-disabled',
      displayName: 'Heavy disabled',
      category: 'a',
      description: 'd',
      source: { repository: 'https://example.com/r' },
      maturity: 'stable',
      enabledByDefault: false,
      allowedProfiles: ['a'],
      runner: { type: 'process', command: ['true'] },
      resources: { timeoutSeconds: 5, maxOutputBytes: 1024 },
      network: { mode: 'none', requiresScopeApproval: false },
      output: { parser: 'passthrough' },
      scheduling: { costTier: 'heavy', falsePositiveRisk: 'low' },
    })
    const checker = new HealthChecker({ catalog, execute: false })
    const rows = await checker.checkAllAsync({ enableNetwork: false })
    expect(rows.length).toBe(2)
    const counts = summarizeDoctor(rows)
    expect(counts.READY).toBe(1)
    expect(counts.DISABLED_HEAVY).toBe(1)
    const formatted = formatDoctor(rows)
    expect(formatted).toContain('ready-stable')
    expect(formatted).toContain('heavy-disabled')
    void join
    void rmSync
  })

  it('Doctor formats rows in stable order for CLI output', async () => {
    const catalog = new OneShotCatalog()
    const registry = new OneShotRegistry(catalog)
    registry.register({
      id: 'z-tool',
      displayName: 'Z',
      category: 'c',
      description: 'd',
      source: { repository: 'https://example.com/r' },
      maturity: 'stable',
      enabledByDefault: true,
      allowedProfiles: ['c'],
      runner: { type: 'process', command: ['true'] },
      resources: { timeoutSeconds: 5, maxOutputBytes: 1024 },
      network: { mode: 'none', requiresScopeApproval: false },
      output: { parser: 'passthrough' },
      scheduling: { costTier: 'fast', falsePositiveRisk: 'low' },
    })
    registry.register({
      id: 'a-tool',
      displayName: 'A',
      category: 'c',
      description: 'd',
      source: { repository: 'https://example.com/r' },
      maturity: 'stable',
      enabledByDefault: true,
      allowedProfiles: ['c'],
      runner: { type: 'process', command: ['true'] },
      resources: { timeoutSeconds: 5, maxOutputBytes: 1024 },
      network: { mode: 'none', requiresScopeApproval: false },
      output: { parser: 'passthrough' },
      scheduling: { costTier: 'fast', falsePositiveRisk: 'low' },
    })
    const checker = new HealthChecker({ catalog, execute: false })
    const rows = await checker.checkAllAsync({ enableNetwork: false })
    const ids = rows.map((r: DoctorRow) => r.manifestId)
    expect(ids).toEqual(['a-tool', 'z-tool'])
  })
})
