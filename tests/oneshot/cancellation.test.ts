import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  OneShotCatalog,
  OneShotRegistry,
  Dispatcher,
  setRunnerOverride,
  clearRunnerOverrides,
} from '../../src/ctf/oneshot/index.js'
import { BackgroundJobManager } from '../../src/core/backgroundJobs.js'
import type { OneShotRunner, RunnerInputs } from '../../src/ctf/oneshot/index.js'
import type { OneShotManifest, OneShotResult } from '../../src/ctf/oneshot/index.js'

function raw(): OneShotManifest {
  return {
    id: 'demo',
    displayName: 'Demo',
    category: 'demo',
    description: 'd',
    source: { repository: 'https://example.com/r' },
    maturity: 'stable',
    enabledByDefault: true,
    allowedProfiles: ['triage'],
    runner: { type: 'process', command: ['demo'] },
    resources: { timeoutSeconds: 60, maxOutputBytes: 1024 },
    network: { mode: 'none', requiresScopeApproval: false },
    output: { parser: 'passthrough' },
    scheduling: { costTier: 'fast', falsePositiveRisk: 'low' },
  }
}

describe('cancellation', () => {
  it('cooperative abort cancels the runner', async () => {
    const root = mkdtempSync(join(tmpdir(), 'oneshot-cancel-'))
    try {
      const catalog = new OneShotCatalog()
      const registry = new OneShotRegistry(catalog)
      registry.register(raw())
      const jobManager = new BackgroundJobManager(
        { taskWorkspaceDir: root },
        async () => ({}),
      )
      const ctrl = new AbortController()
      const dispatcher = new Dispatcher({
        registry,
        catalog,
        jobManager,
        workspace: root,
        signal: ctrl.signal,
      })
      clearRunnerOverrides()
      setRunnerOverride('demo', {
        async run(_m: OneShotManifest, inputs: RunnerInputs): Promise<OneShotResult> {
          await new Promise<void>((resolve, reject) => {
            inputs.signal.addEventListener('abort', () => reject(new Error('aborted')))
            setTimeout(resolve, 2000)
          })
          return {
            runId: 'osp_x',
            manifestId: 'demo',
            taskId: 't',
            status: 'cancelled',
            startedAt: '',
            finishedAt: '',
            findings: [],
            artifacts: [],
            candidates: [],
            diagnostics: { truncated: false, parserWarnings: [] },
            confidence: 0,
            falsePositiveRisk: 'low',
            summary: '',
          }
        },
      } as OneShotRunner)
      const promise = dispatcher.runOne('demo', {
        argv: [],
        evidenceRoot: root,
        signal: ctrl.signal,
      })
      setTimeout(() => ctrl.abort(), 30)
      await expect(promise).rejects.toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
