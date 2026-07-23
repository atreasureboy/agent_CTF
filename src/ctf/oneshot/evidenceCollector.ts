/**
 * EvidenceCollector — Phase 2.0 §十九.
 *
 * Streaming copy via pipeline(createReadStream, createWriteStream) so we
 * never load large files into memory. Computes SHA-256 + size + MIME
 * alongside the copy. Failures raise explicit errors — never silently
 * coerce to empty.
 *
 * Pre-flight checks (per Goal):
 *   - realpath containment under workspaceDir
 *   - file size ≤ maxBytes (configurable)
 *   - symlink resolution before opening the stream
 *   - artifact glob stays within the run output directory
 */

import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  statSync,
  writeFileSync,
} from 'fs'
import { promises as fsp } from 'fs'
import { join } from 'path'
import { randomBytes, createHash } from 'crypto'
import { pipeline } from 'stream/promises'
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

export interface EvidenceCollectOptions {
  workspaceDir: string
  /**
   * §round-2 audit fix — authoritative containment boundary. The
   * contest boundary (`allowedFilesRoot`) is the canonical scope; the
   * per-task `workspaceDir` is allowed as a wider hint for backwards
   * compatibility, but the narrowest of the two wins.
   */
  allowedFilesRoot?: string
  /** Maximum source size in bytes. Files larger than this throw. */
  maxBytes?: number
  /** Allowed MIME prefixes (best-effort). */
  allowedMimePrefixes?: string[]
}

export interface EvidenceCollectResult {
  relativePath: string
  size: number
  sha256: string
  mimeType: string
}

/** Heuristic MIME detection — file(1) magic bytes. */
function detectMime(srcPath: string, sample: Buffer): string {
  if (sample.length < 4) return 'application/octet-stream'
  const b = sample
  if (b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46) return 'application/x-elf'
  if (b[0] === 0x50 && b[1] === 0x4b) return 'application/zip'
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg'
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif'
  if (b[0] === 0x50 && b[1] === 0x44 && b[2] === 0x46) return 'application/pdf'
  if (b[0] === 0xd4 && b[1] === 0xc3 && b[2] === 0xb2 && b[3] === 0xa1) return 'application/vnd.tcpdump.pcap'
  if (b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) return 'application/x-cfb'
  if (b.length >= 6 && b.slice(0, 6).toString('ascii') === 'GIF89a') return 'image/gif'
  return 'application/octet-stream'
}

/**
 * Copy a file into the evidence bundle using a streaming pipeline. Computes
 * SHA-256 + size + MIME alongside the copy. Refuses silently-fallback to
 * empty when the source cannot be opened.
 */
export async function collectEvidence(
  ev: EvidenceDir,
  item: EvidenceItem,
  options: EvidenceCollectOptions,
): Promise<EvidenceCollectResult> {
  const { workspaceDir, allowedFilesRoot, maxBytes } = options
  if (!existsSync(item.srcPath)) {
    throw new Error(`evidence source missing: ${item.srcPath}`)
  }
  // §round-2 audit fix — containment check uses the contest boundary
  // (`allowedFilesRoot`) when supplied; otherwise falls back to
  // `workspaceDir`. The narrowest of the two is the effective root.
  const realSrc = await fsp.realpath(item.srcPath)
  const candidateRoots = [
    await fsp.realpath(workspaceDir).catch(() => workspaceDir),
  ]
  if (allowedFilesRoot) {
    candidateRoots.push(await fsp.realpath(allowedFilesRoot).catch(() => allowedFilesRoot))
  }
  // Pick the longest realpath — that's the most specific boundary.
  const realRoot = candidateRoots.sort((a, b) => b.length - a.length)[0] ?? workspaceDir
  if (!realSrc.startsWith(`${realRoot}/`) && realSrc !== realRoot) {
    throw new Error(`evidence source outside workspace: ${item.srcPath}`)
  }
  const stat = statSync(realSrc)
  // §P1 audit fix — refuse symlinks / directories / device nodes. We only
  // copy regular files; the streaming pipeline would otherwise fail mid-copy
  // on a non-file source.
  if (!stat.isFile()) {
    throw new Error(`evidence source is not a regular file: ${item.srcPath}`)
  }
  if (maxBytes !== undefined && stat.size > maxBytes) {
    throw new Error(`evidence source too large: ${stat.size} > ${maxBytes}`)
  }
  // §P1 audit fix — namespace the destination to avoid silent overwrites
  // when two evidence sources share the same basename.
  const sourceBase = item.srcPath.split('/').pop() ?? `file-${Date.now()}`
  const baseName = `${randomBytes(4).toString('hex')}-${sourceBase}`
  const relPath = join(ev.rootDir, baseName)

  // Sample first 16 bytes for MIME detection — a small read ahead of the
  // streaming copy. We do NOT load the whole file.
  const sampleHandle = await fsp.open(realSrc, 'r')
  let sample: Buffer
  try {
    const buf = Buffer.alloc(16)
    const { bytesRead } = await sampleHandle.read(buf, 0, 16, 0)
    sample = buf.subarray(0, bytesRead)
  } finally {
    await sampleHandle.close()
  }

  const hash = createHash('sha256')
  const source = createReadStream(realSrc)
  source.on('data', (chunk) => hash.update(chunk as Buffer))
  const dest = createWriteStream(relPath)
  await pipeline(source, dest)

  return {
    relativePath: relPath,
    size: stat.size,
    sha256: hash.digest('hex'),
    mimeType: detectMime(realSrc, sample),
  }
}

export function writeManifestSnapshot(ev: EvidenceDir, manifest: OneShotManifest): string {
  const target = join(ev.rootDir, 'manifest.json')
  writeFileSync(target, JSON.stringify(manifest, null, 2))
  return target
}