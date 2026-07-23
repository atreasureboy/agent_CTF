/**
 * Artifact / Finding / Handoff stores — round-trip persistence + listing.
 */

import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { ArtifactStore } from '../src/core/artifacts.js'
import { FindingStore } from '../src/core/findings.js'
import { HandoffStore } from '../src/core/handoff.js'

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentctf-'))
  return dir
}

describe('ArtifactStore', () => {
  it('writes, summarises, and reads back artifacts with sha256', () => {
    const root = tmpRoot()
    try {
      const s = new ArtifactStore(root)
      const meta = s.writeSync(
        {
          taskId: 't1',
          producerAgentId: 'image-stego',
          type: 'binwalk-extract',
          source: { toolId: 'Bash', inputSummary: 'binwalk -e a.png' },
        },
        'A'.repeat(20_000),
        'bin',
      )
      expect(meta.sha256).toHaveLength(64)
      expect(meta.size).toBe(20_000)
      expect(meta.path).toMatch(/^bin\/art_/)
      expect(meta.summary.length).toBeLessThan(2000)

      const read = s.read(meta.id)
      expect(read?.id).toBe(meta.id)

      const all = s.list()
      expect(all.length).toBe(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('summarises long buffers with head+tail', () => {
    const root = tmpRoot()
    try {
      const s = new ArtifactStore(root)
      const long = 'X'.repeat(50_000)
      const meta = s.writeSync(
        { taskId: 't', producerAgentId: 'triage', type: 'string-extract' },
        long,
        'txt',
      )
      expect(meta.summary).toMatch(/\[\.\.\. \d+ bytes \.\.\.\]/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('survives a partial trailing line on the next write (atomic-recover)', async () => {
    // Phase 1.7 audit — atomic write must trim any dangling partial line
    // from a previous crash so the recovered file is valid JSONL.
    const fs = await import('fs/promises')
    const root = tmpRoot()
    try {
      const s = new ArtifactStore(root)
      s.writeSync(
        { taskId: 't1', producerAgentId: 'triage', type: 'first' },
        'first payload',
        'txt',
      )
      const metaPath = join(root, 'artifacts', 'index.jsonl')
      // Inject a dangling partial line as if a crash mid-write had
      // interrupted the original second append.
      await fs.appendFile(metaPath, '{"id":"art_partial","taskId":"t1"')
      s.writeSync(
        { taskId: 't1', producerAgentId: 'triage', type: 'second' },
        'second payload',
        'txt',
      )
      // Both valid entries are present; the dangling partial line is dropped.
      const all = s.list()
      expect(all.length).toBe(2)
      const types = all.map((a) => a.type).sort()
      expect(types).toEqual(['first', 'second'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('FindingStore', () => {
  it('appends and lists findings', () => {
    const root = tmpRoot()
    try {
      const s = new FindingStore(root)
      s.append({
        taskId: 't1', producerAgentId: 'triage',
        category: 'triage', title: 'PNG detected', summary: 'magic=89504e47', confidence: 'high',
      })
      s.append({
        taskId: 't1', producerAgentId: 'image-stego',
        category: 'image', title: 'extracted ZIP', summary: 'art_xx1', confidence: 'medium',
        artifactIds: ['art_xx1'], suggestedAgent: 'file-forensics',
      })
      expect(s.list().length).toBe(2)
      const filtered = s.list((f) => f.category === 'image')
      expect(filtered.length).toBe(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('HandoffStore', () => {
  it('submits and lists pending handoffs', () => {
    const root = tmpRoot()
    try {
      const s = new HandoffStore(root)
      const r = s.submit({
        taskId: 't1', fromAgent: 'image-stego',
        suggestedAgent: 'file-forensics',
        reason: 'Extracted nested ZIP', objective: 'Extract and triage contents',
        artifactIds: ['art_xx'], findingIds: ['find_yy'],
      })
      expect(r.id).toMatch(/^hof_/)
      expect(s.pending().length).toBe(1)

      s.decide(r.id, 'approved', 'go for it')
      expect(s.pending().length).toBe(0)
      const decided = s.list().find((x) => x.id === r.id)
      expect(decided?.status).toBe('approved')
      expect(decided?.decisionReason).toBe('go for it')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
