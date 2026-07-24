/**
 * FileParser — Phase 2.1 §十四.
 *
 * Detects file type from the first 16 bytes (magic). Produces
 * file_type Observation + file_signature Evidence + SuggestedAction
 * pointing to a type-specific workflow.
 */

import type { ResultParser, ParserInput, MaterializedResult } from '../parserRegistry.js'

interface MagicEntry {
  ext: string
  mime: string
  magic: number[]
  label: string
}

const MAGIC_TABLE: MagicEntry[] = [
  { ext: 'png', mime: 'image/png', magic: [0x89, 0x50, 0x4e, 0x47], label: 'PNG image' },
  { ext: 'jpg', mime: 'image/jpeg', magic: [0xff, 0xd8, 0xff], label: 'JPEG image' },
  { ext: 'gif', mime: 'image/gif', magic: [0x47, 0x49, 0x46, 0x38], label: 'GIF image' },
  { ext: 'pdf', mime: 'application/pdf', magic: [0x25, 0x50, 0x44, 0x46], label: 'PDF document' },
  { ext: 'zip', mime: 'application/zip', magic: [0x50, 0x4b, 0x03, 0x04], label: 'ZIP archive' },
  { ext: 'gz', mime: 'application/gzip', magic: [0x1f, 0x8b], label: 'GZIP' },
  { ext: '7z', mime: 'application/x-7z-compressed', magic: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], label: '7z archive' },
  { ext: 'rar', mime: 'application/vnd.rar', magic: [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07], label: 'RAR archive' },
  { ext: 'elf', mime: 'application/x-elf', magic: [0x7f, 0x45, 0x4c, 0x46], label: 'ELF binary' },
  { ext: 'pcap', mime: 'application/vnd.tcpdump.pcap', magic: [0xd4, 0xc3, 0xb2, 0xa1], label: 'PCAP' },
  { ext: 'pcapng', mime: 'application/vnd.tcpdump.pcap', magic: [0x0a, 0x0d, 0x0d, 0x0a], label: 'PCAPNG' },
  { ext: 'macho', mime: 'application/x-mach-binary', magic: [0xfe, 0xed, 0xfa, 0xce], label: 'Mach-O 64' },
  { ext: 'class', mime: 'application/java-vm', magic: [0xca, 0xfe, 0xba, 0xbe], label: 'Java class' },
]

function readFirstBytes(content: string | undefined, stdoutPath: string | undefined): number[] | null {
  if (stdoutPath) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require('fs') as typeof import('fs')
      const fd = fs.openSync(stdoutPath, 'r')
      try {
        const buf = Buffer.alloc(16)
        const n = fs.readSync(fd, buf, 0, 16, 0)
        return Array.from(buf.subarray(0, n))
      } finally {
        fs.closeSync(fd)
      }
    } catch {
      return null
    }
  }
  if (!content) return null
  // Treat content as Latin-1 bytes (one char = one byte). This gives
  // us back the raw magic for any binary stream that was passed in
  // as a string by upstream tooling.
  const bytes: number[] = []
  for (let i = 0; i < Math.min(content.length, 16); i++) {
    bytes.push(content.charCodeAt(i) & 0xff)
  }
  return bytes
}

function matchesAt(bytes: number[], magic: number[]): boolean {
  if (bytes.length < magic.length) return false
  for (let i = 0; i < magic.length; i++) {
    if (bytes[i] !== magic[i]) return false
  }
  return true
}

export const fileParser: ResultParser = {
  id: 'file',
  supports(input) {
    return Boolean(input.toolId === 'file' || input.manifestId === 'file' || input.stepId === 'file')
  },
  async parse(input: ParserInput): Promise<MaterializedResult> {
    const bytes = readFirstBytes(input.content, input.stdoutPath)
    const observations: MaterializedResult['observations'] = []
    const evidence: MaterializedResult['evidence'] = []
    if (!bytes || bytes.length === 0) {
      observations.push({
        kind: 'tool_availability',
        source: input.source,
        summary: 'file: no bytes available',
        confidence: 0.5,
      })
      return { observations, evidence, suggestedActions: [], flagCandidateDrafts: [], warnings: ['file: no bytes'], rawArtifactIds: input.artifactIds }
    }
    const entry = MAGIC_TABLE.find((m) => matchesAt(bytes, m.magic))
    if (!entry) {
      observations.push({
        kind: 'file_type',
        source: input.source,
        summary: 'unknown file type',
        confidence: 0.5,
      })
      return { observations, evidence, suggestedActions: [], flagCandidateDrafts: [], warnings: ['file: unknown magic'], rawArtifactIds: input.artifactIds }
    }
    observations.push({
      kind: 'file_type',
      source: input.source,
      summary: `${entry.label} (${entry.mime})`,
      attributes: { ext: entry.ext, mime: entry.mime },
      confidence: 0.95,
    })
    evidence.push({
      kind: 'file_signature',
      claim: `file is ${entry.label} (${entry.mime})`,
      polarity: 'supports',
      source: {
        producer: { type: 'parser', id: 'file' },
        observationIds: [],
        artifactIds: input.artifactIds,
        attemptIds: [],
        confidence: 0.95,
        createdAt: Date.now(),
      },
    })
    // Suggest a type-specific next workflow.
    if (['png', 'jpg', 'gif'].includes(entry.ext)) {
      evidence.push({
        kind: 'generic',
        claim: 'image container — image_quick_scan recommended',
        polarity: 'supports',
        source: {
          producer: { type: 'parser', id: 'file' },
          observationIds: [],
          artifactIds: input.artifactIds,
          attemptIds: [],
          confidence: 0.7,
          createdAt: Date.now(),
        },
      })
    } else if (['zip', 'gz', '7z', 'rar'].includes(entry.ext)) {
      evidence.push({
        kind: 'embedded_archive',
        claim: 'archive container — extract and triage contents',
        polarity: 'supports',
        source: {
          producer: { type: 'parser', id: 'file' },
          observationIds: [],
          artifactIds: input.artifactIds,
          attemptIds: [],
          confidence: 0.7,
          createdAt: Date.now(),
        },
      })
    } else if (['elf', 'macho', 'class'].includes(entry.ext)) {
      evidence.push({
        kind: 'binary_protection',
        claim: 'binary detected — run checksec / reverse specialist',
        polarity: 'supports',
        source: {
          producer: { type: 'parser', id: 'file' },
          observationIds: [],
          artifactIds: input.artifactIds,
          attemptIds: [],
          confidence: 0.6,
          createdAt: Date.now(),
        },
      })
    } else if (entry.ext === 'pcap' || entry.ext === 'pcapng') {
      evidence.push({
        kind: 'generic',
        claim: 'packet capture — run pcap triage',
        polarity: 'supports',
        source: {
          producer: { type: 'parser', id: 'file' },
          observationIds: [],
          artifactIds: input.artifactIds,
          attemptIds: [],
          confidence: 0.6,
          createdAt: Date.now(),
        },
      })
    }
    return {
      observations,
      evidence,
      suggestedActions: [],
      flagCandidateDrafts: [],
      warnings: [],
      rawArtifactIds: input.artifactIds,
    }
  },
}