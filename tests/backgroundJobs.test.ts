/**
 * BackgroundJobManager — spawn, wait, cancel, persistence.
 */

import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { BackgroundJobManager, type JobRunner } from '../src/core/backgroundJobs.js'

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'agentctf-jobs-'))
}

describe('BackgroundJobManager', () => {
  it('spawns and resolves a successful job', async () => {
    const root = tmpRoot()
    try {
      const runner: JobRunner = async () => ({ summary: 'done', artifactId: 'art_x' })
      const m = new BackgroundJobManager({ taskWorkspaceDir: root }, runner)
      const job = await m.spawn({
        taskId: 't1', agentId: 'web', toolId: 'nmap',
        input: { target: 'example.com' }, timeoutMs: 1000,
      })
      const final = await m.wait(job.id, 5000)
      expect(final.status).toBe('success')
      expect(final.artifactId).toBe('art_x')
      expect(final.summary).toBe('done')
      expect(final.endedAt).toBeTruthy()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('marks job as failed when the runner throws', async () => {
    const root = tmpRoot()
    try {
      const runner: JobRunner = async () => { throw new Error('boom') }
      const m = new BackgroundJobManager({ taskWorkspaceDir: root }, runner)
      const job = await m.spawn({ taskId: 't1', agentId: 'web', toolId: 'nmap', input: {}, timeoutMs: 1000 })
      const final = await m.wait(job.id, 5000)
      expect(final.status).toBe('failed')
      expect(final.error).toBe('boom')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('cancels a running job via abort', async () => {
    const root = tmpRoot()
    try {
      let captured: AbortSignal | undefined
      const runner: JobRunner = async (_spec, signal) => {
        captured = signal
        return await new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => {
            const reason = signal.reason
            resolve({ error: `cancelled:${reason ?? 'unknown'}` })
          })
          setTimeout(() => reject(new Error('timeout in test runner (signal was not honoured)')), 1500)
        })
      }
      const m = new BackgroundJobManager({ taskWorkspaceDir: root }, runner)
      const job = await m.spawn({ taskId: 't1', agentId: 'web', toolId: 'nmap', input: {}, timeoutMs: 10_000 })
      // Give the job a moment to start executing.
      await new Promise((r) => setTimeout(r, 30))
      const ok = m.cancel(job.id, 'orchestrator_says_stop')
      expect(ok).toBe(true)
      const final = await m.wait(job.id, 5000)
      expect(['cancelled', 'failed']).toContain(final.status)
      expect(captured?.aborted).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects spawn when agent concurrency limit is reached', async () => {
    const root = tmpRoot()
    try {
      const runner: JobRunner = async (_s, signal) => {
        // Never completes naturally — wait until cancelled so the test runs fast.
        await new Promise((resolve) => signal.addEventListener('abort', resolve))
        return { error: 'aborted in test' }
      }
      const m = new BackgroundJobManager(
        { taskWorkspaceDir: root, maxPerAgent: 2, maxPerTask: 8 },
        runner,
      )
      await m.spawn({ taskId: 't1', agentId: 'a', toolId: 'nmap', input: {}, timeoutMs: 60_000 })
      await m.spawn({ taskId: 't1', agentId: 'a', toolId: 'nmap', input: {}, timeoutMs: 60_000 })

      // 3rd should hit the agent cap (maxPerAgent=2).
      await expect(
        m.spawn({ taskId: 't1', agentId: 'a', toolId: 'nmap', input: {}, timeoutMs: 60_000 }),
      ).rejects.toThrow(/maxPerAgent/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects spawn when task concurrency limit is reached', async () => {
    const root = tmpRoot()
    try {
      const runner: JobRunner = async (_s, signal) => {
        await new Promise((resolve) => signal.addEventListener('abort', resolve))
        return { error: 'aborted in test' }
      }
      const m = new BackgroundJobManager(
        { taskWorkspaceDir: root, maxPerAgent: 8, maxPerTask: 2 },
        runner,
      )
      await m.spawn({ taskId: 't1', agentId: 'a1', toolId: 'nmap', input: {}, timeoutMs: 60_000 })
      await m.spawn({ taskId: 't1', agentId: 'a2', toolId: 'nmap', input: {}, timeoutMs: 60_000 })
      await expect(
        m.spawn({ taskId: 't1', agentId: 'a3', toolId: 'nmap', input: {}, timeoutMs: 60_000 }),
      ).rejects.toThrow(/maxPerTask/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
