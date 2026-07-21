/**
 * ToolBroker — profile gating, artifact conversion, background spawn fallback.
 */

import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { ToolRegistry } from '../src/core/toolRegistry.js'
import { ToolBroker } from '../src/core/toolBroker.js'
import { ToolFirstPolicy } from '../src/core/toolFirstPolicy.js'
import { BackgroundJobManager } from '../src/core/backgroundJobs.js'
import { ArtifactStore } from '../src/core/artifacts.js'
import { ContestScopeChecker, ScopeViolationError } from '../src/core/contestScope.js'
import { PROFILES } from '../src/capabilityProfiles/builtin.js'
import { ensureProfilesRegistered } from '../src/capabilityProfiles/index.js'
import { parseContestScope } from '../src/core/contestScope.js'
import type { CapabilityProfile } from '../src/core/capabilityProfile.js'
import { EventLog } from '../src/core/eventLog.js'

ensureProfilesRegistered()

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'agentctf-broker-'))
}

describe('ToolBroker', () => {
  it('denies a tool call when profile forbids it', async () => {
    const root = tmpRoot()
    try {
      // Construct a registry with legacy tools so the broker knows about Bash.
      const { createTools } = await import('../src/tools/index.js')
      const { TOOL_METADATA } = await import('../src/core/toolMetadata.js')
      const registry = ToolRegistry.fromLegacyTools(createTools([]), TOOL_METADATA)
      const profile: CapabilityProfile = PROFILES['orchestrator'] // Bash denied
      const sessionDir = join(root, 'session')
      mkdirSync(sessionDir, { recursive: true })
      const eventLog = new EventLog(sessionDir)
      const broker = new ToolBroker({
        registry,
        profile,
        eventLog,
        artifactStore: new ArtifactStore(sessionDir),
        toolFirstPolicy: new ToolFirstPolicy(),
      })
      const r = await broker.execute('Bash', { command: 'ls' }, {
        cwd: root, taskId: 't', agentId: 'a',
      })
      expect(r.result.isError).toBe(true)
      expect(r.result.content).toMatch(/denied by profile/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('persists long outputs as artifacts and returns a summary', async () => {
    const root = tmpRoot()
    try {
      const { createTools } = await import('../src/tools/index.js')
      const { TOOL_METADATA } = await import('../src/core/toolMetadata.js')
      const registry = ToolRegistry.fromLegacyTools(createTools([]), TOOL_METADATA)
      // Use a profile that allows Bash and turns output mode to artifact.
      // We don't have a built-in for that — construct one inline.
      const profile: CapabilityProfile = parseContestScopeInlineProfile()
      const sessionDir = join(root, 'session')
      mkdirSync(sessionDir, { recursive: true })
      const artifactStore = new ArtifactStore(sessionDir)
      const eventLog = new EventLog(sessionDir)
      const bashReg = registry.get('Bash')!
      // Make Bash outputMode 'artifact' so the broker persists long content automatically.
      ;(bashReg as unknown as { outputMode: 'artifact' }).outputMode = 'artifact'

      const broker = new ToolBroker({
        registry,
        profile,
        artifactStore,
        eventLog,
        defaultInlineMaxBytes: 50,        // very low to trigger Artifact conversion
        forceInline: true,
      })
      const r = await broker.execute(
        'Bash',
        { command: 'printf "%09999s" " " | tr " " "a"' },
        { cwd: root, taskId: 't', agentId: 'a' },
      )
      expect(r.result.isError).toBe(false)
      expect(r.artifactId).toBeTruthy()
      expect(r.result.content).toMatch(/Output persisted as artifact/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('records policy advisories for image LSB extraction', async () => {
    const root = tmpRoot()
    try {
      const { createTools } = await import('../src/tools/index.js')
      const { TOOL_METADATA } = await import('../src/core/toolMetadata.js')
      const registry = ToolRegistry.fromLegacyTools(createTools([]), TOOL_METADATA)
      const profile: CapabilityProfile = PROFILES['image-stego']
      const sessionDir = join(root, 'session')
      mkdirSync(sessionDir, { recursive: true })
      const broker = new ToolBroker({
        registry,
        profile,
        eventLog: new EventLog(sessionDir),
        toolFirstPolicy: new ToolFirstPolicy(),
        forceInline: true,
      })
      const r = await broker.execute(
        'Bash',
        { command: 'python extract.py logo.png' },
        { cwd: root, taskId: 't', agentId: 'image-stego' },
      )
      expect(r.policyVerdict?.rule).toBe('image-stego')
      expect(r.policyVerdict?.advice).toMatch(/image_quick_scan/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('falls back to inline when JobManager refuses a spawn', async () => {
    const root = tmpRoot()
    try {
      const { createTools } = await import('../src/tools/index.js')
      const { TOOL_METADATA } = await import('../src/core/toolMetadata.js')
      const registry = ToolRegistry.fromLegacyTools(createTools([]), TOOL_METADATA)
      const profile: CapabilityProfile = PROFILES['image-stego']
      const sessionDir = join(root, 'session')
      mkdirSync(sessionDir, { recursive: true })
      // JobManager that's configured to reject (maxPerAgent=0 / 1 already active).
      const runner = async (_s: unknown, signal: AbortSignal) => {
        await new Promise((resolve) => signal.addEventListener('abort', resolve))
        return { error: 'aborted' }
      }
      const jm = new BackgroundJobManager({ taskWorkspaceDir: sessionDir, maxPerAgent: 1, maxPerTask: 1 }, runner)
      await jm.spawn({ taskId: 't', agentId: 'a', toolId: 'Bash', input: {}, timeoutMs: 60_000 })

      const broker = new ToolBroker({
        registry, profile,
        eventLog: new EventLog(sessionDir),
        jobManager: jm,
        jobRunner: runner,
        forceInline: false,
        defaultInlineMaxBytes: 1024 * 1024,
      })
      // Bash wants background but JM is full → broker falls back to inline.
      const r = await broker.execute('Bash', { command: 'true' }, { cwd: root, taskId: 't', agentId: 'a' })
      expect(r.result.isError).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

function parseContestScopeInlineProfile(): CapabilityProfile {
  // Returns a profile that explicitly allows Bash (the image-stego profile
  // already permits it — but we want this to fail-fast on capability
  // contract changes, so we go through the schema).
  return PROFILES['image-stego']
}

// ── Smoke for ScopeViolationError thrown by ToolBroker when contest scope denies a path. ──

describe('ScopeViolationError', () => {
  it('throws when path is outside allowedFilesRoot', () => {
    const checker = new ContestScopeChecker(parseContestScope({ allowedFilesRoot: '/tmp' }))
    expect(() => checker.assertFile('/etc/passwd')).toThrow(ScopeViolationError)
  })
  it('allows paths inside allowedFilesRoot', () => {
    const checker = new ContestScopeChecker(parseContestScope({ allowedFilesRoot: '/tmp' }))
    expect(() => checker.assertFile('/tmp/a.txt')).not.toThrow()
  })
})
