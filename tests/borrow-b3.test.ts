/**
 * Phase B3 — long-trajectory compaction.
 */

import { describe, it, expect } from 'vitest'
import { mkdtemp, rm, readFile, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { compactToFile } from '../src/core/ctfReasoning/longTrajectoryCompactor.js'
import { createTestTaskState } from './fixtures/createTestTaskState.js'
import { createObservation } from '../src/core/ctfReasoning/observation.js'

describe('LongTrajectoryCompactor (B3)', () => {
  it('writes old observations to a JSONL file and returns a summary', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ctf-lt-'))
    try {
      const state = createTestTaskState({ taskId: 'lt-1' })
      const observations = [
        createObservation('lt-1', { kind: 'generic', source: { type: 'manual' }, summary: 'obs 1', confidence: 0.5 }),
        createObservation('lt-1', { kind: 'generic', source: { type: 'manual' }, summary: 'obs 2', confidence: 0.5 }),
        createObservation('lt-1', { kind: 'generic', source: { type: 'manual' }, summary: 'obs 3', confidence: 0.5 }),
      ]
      const r = await compactToFile(state, observations, { workspaceDir: dir, at: 1234567890 })
      expect(r.archiveCount).toBe(3)
      expect(r.archivePath).toContain('obs-')
      const fileStat = await stat(r.archivePath)
      expect(fileStat.size).toBeGreaterThan(0)
      const content = await readFile(r.archivePath, 'utf-8')
      expect(content).toContain('"summary":"obs 1"')
      expect(r.summary).toContain('compactor-archives/')
      expect(r.summary).toContain('3 observations')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('works on an empty observation list', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ctf-lt-empty-'))
    try {
      const state = createTestTaskState({ taskId: 'lt-empty' })
      const r = await compactToFile(state, [], { workspaceDir: dir, at: 1 })
      expect(r.archiveCount).toBe(0)
      // File is still written (empty JSONL).
      const content = await readFile(r.archivePath, 'utf-8')
      expect(content).toBe('\n')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
