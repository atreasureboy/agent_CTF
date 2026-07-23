/**
 * EvidenceCollector — writes a per-run evidence bundle to disk.
 *
 * Every run produces:
 *   - <runId>.stdout.log   — raw tool stdout (truncated at maxOutputBytes)
 *   - <runId>.stderr.log   — raw tool stderr (truncated)
 *   - <runId>.jsonl        — structured event trail (start/progress/end)
 *   - <runId>.manifest.json — captured manifest snapshot
 *
 * Returned paths are persisted in `OneShotResult.diagnostics` so callers
 * can `cat` them via the Read tool without leaking through the LLM context.
 */

import { existsSync, mkdirSync, writeFileSync, statSync } from 'fs'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { createHash } from 'crypto'
import type { OneShotManifest } from './types.js'

export interface EvidenceDir {
  rootDir: string
  runId: string
}

export function newEvidenceDir(parentDir: string): EvidenceDir {
  const runId = `ose_${randomBytes(6).toString('hex')}`
  const rootDir = join(parentDir, runId)
  mkdirSync(rootDir, { recursive: true })
  return { rootDir, runId }
}

export interface EvidenceItem {
  srcPath: string
  type?: string
  hint?: string
}

/** Copy a file into the evidence bundle and return its size + sha256. */
export function collectEvidence(
  ev: EvidenceDir,
  item: EvidenceItem,
): { relativePath: string; size: number; sha256: string } {
  if (!existsSync(item.srcPath)) {
    return { relativePath: '', size: 0, sha256: '' }
  }
  const baseName = item.srcPath.split('/').pop() ?? `file-${Date.now()}`
  const relPath = join(ev.rootDir, baseName)
  const src = statSync(item.srcPath)
  const data = readOrEmpty(item.srcPath)
  writeFileSync(relPath, data)
  const sha = createHash('sha256').update(data).digest('hex')
  return { relativePath: relPath, size: src.size, sha256: sha }
}

function readOrEmpty(p: string): Buffer {
  try {
    const fs = require('fs') as typeof import('fs')
    return fs.readFileSync(p)
  } catch {
    return Buffer.alloc(0)
  }
}

export function writeManifestSnapshot(ev: EvidenceDir, manifest: OneShotManifest): string {
  const target = join(ev.rootDir, 'manifest.json')
  writeFileSync(target, JSON.stringify(manifest, null, 2))
  return target
}
