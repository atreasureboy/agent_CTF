import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  ProcessRunner,
  ContainerRunner,
  ServiceRunner,
  setRunnerOverride,
  clearRunnerOverrides,
} from '../../src/ctf/oneshot/index.js'
import type { OneShotManifest } from '../../src/ctf/oneshot/index.js'

function base(over: Partial<OneShotManifest> = {}): OneShotManifest {
  return {
    id: 'demo',
    displayName: 'demo',
    category: 'demo',
    description: 'd',
    source: { repository: 'https://example.com/r' },
    maturity: 'stable',
    enabledByDefault: true,
    allowedProfiles: ['triage'],
    runner: { type: 'process', command: ['echo', 'hello'] },
    resources: { timeoutSeconds: 30, maxOutputBytes: 1024 },
    network: { mode: 'none', requiresScopeApproval: false },
    output: { parser: 'passthrough' },
    scheduling: { costTier: 'fast', falsePositiveRisk: 'low' },
    ...over,
  }
}

describe('runners', () => {
  it('ProcessRunner executes a real command and persists stdout', async () => {
    const root = mkdtempSync(join(tmpdir(), 'oneshot-runner-'))
    try {
      const runner = new ProcessRunner()
      const result = await runner.run(base(), {
        logDir: root,
        argv: [],
        workspace: root,
        signal: new AbortController().signal,
      })
      expect(result.status).toBe('completed')
      expect(existsSync(result.diagnostics.stdoutPath ?? '')).toBe(true)
      const stdout = readFileSync(result.diagnostics.stdoutPath!, 'utf8')
      expect(stdout.trim()).toBe('hello')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('ProcessRunner truncates at maxOutputBytes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'oneshot-runner-'))
    try {
      const runner = new ProcessRunner()
      const result = await runner.run(
        base({ resources: { timeoutSeconds: 30, maxOutputBytes: 4 } }),
        {
          logDir: root,
          // `printf` outputs without newline so a small stdout can exceed the cap.
          argv: ['hello world from a long output stream'],
          workspace: root,
          signal: new AbortController().signal,
        },
      )
      expect(result.diagnostics.truncated).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('ContainerRunner returns unavailable when docker is missing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'oneshot-c-'))
    try {
      const runner = new ContainerRunner({ execute: false })
      const result = await runner.run(
        base({
          maturity: 'experimental',
          runner: { type: 'container', command: ['x'], image: 'alpine:latest' },
        }),
        {
          logDir: root,
          argv: [],
          workspace: root,
          signal: new AbortController().signal,
        },
      )
      expect(result.status).toBe('unavailable')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('ServiceRunner uses injected fetcher', async () => {
    const root = mkdtempSync(join(tmpdir(), 'oneshot-s-'))
    try {
      const submitCalls: string[] = []
      const fetcher = async (
        url: string,
        method: string,
        body: unknown,
        _signal: AbortSignal,
      ): Promise<{ status: number; body: unknown }> => {
        if (method === 'POST' && url.endsWith('/submit')) {
          submitCalls.push(JSON.stringify(body))
          return { status: 200, body: { id: 'job_1' } }
        }
        if (url.endsWith('/status/job_1')) {
          return { status: 200, body: { status: 'completed' } }
        }
        return { status: 404, body: null }
      }
      const runner = new ServiceRunner({ fetcher, pollIntervalMs: 10 })
      const result = await runner.run(
        base({ runner: { type: 'service', endpoint: 'http://localhost:9999' } }),
        {
          logDir: root,
          argv: ['demo-input'],
          workspace: root,
          signal: new AbortController().signal,
        },
      )
      expect(result.status).toBe('completed')
      expect(submitCalls.length).toBe(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
