/**
 * HexHeaderParser — Phase 2.1 §十四.
 *
 * Detects file type by hex header (first 16 bytes printed as
 * hex). Output-only — does not produce a Finding on its own.
 */

import type { ResultParser, ParserInput, MaterializedResult } from '../parserRegistry.js'

const MAGIC: Array<{ magic: number[]; label: string }> = [
  { magic: [0x89, 0x50, 0x4e, 0x47], label: 'PNG' },
  { magic: [0xff, 0xd8, 0xff], label: 'JPEG' },
  { magic: [0x47, 0x49, 0x46, 0x38], label: 'GIF' },
  { magic: [0x50, 0x4b, 0x03, 0x04], label: 'ZIP' },
  { magic: [0x25, 0x50, 0x44, 0x46], label: 'PDF' },
  { magic: [0x7f, 0x45, 0x4c, 0x46], label: 'ELF' },
  { magic: [0x4d, 0x5a], label: 'PE' },
  { magic: [0x1f, 0x8b], label: 'GZIP' },
  { magic: [0x37, 0x7a, 0xbc, 0xaf], label: '7z' },
  { magic: [0x52, 0x61, 0x72, 0x21], label: 'RAR' },
  { magic: [0xd4, 0xc3, 0xb2, 0xa1], label: 'PCAP' },
  { magic: [0x0a, 0x0d, 0x0d, 0x0a], label: 'PCAPNG' },
]

function detectFromHex(hex: string): string | null {
  // §round-4 audit fix — xxd / hexdump output starts with an
  // offset column (e.g. `00000000 8950 4e47 ...`). We split into
  // rows and treat the hex bytes AFTER the offset as the magic
  // window. The first 8 hex bytes per row are enough to identify
  // the most common signatures.
  const rows = hex.split(/\r?\n/)
  for (const row of rows) {
    // Drop optional leading offset (8-hex-digit run).
    const offsetMatch = /^\s*([0-9a-fA-F]{6,8})?\s*(.*)$/.exec(row)
    const body = offsetMatch?.[2] ?? row
    // Drop ASCII column (anything after a `|` marker or run of
    // printable ASCII at the end separated by a space).
    const asciiSplit = body.split('|')
    const hexSide = (asciiSplit[0] ?? body).trim()
    const bytes = hexSide.split(/\s+/).map((b) => Number.parseInt(b, 16)).filter((b) => Number.isFinite(b))
    for (const m of MAGIC) {
      if (bytes.length < m.magic.length) continue
      let ok = true
      for (let i = 0; i < m.magic.length; i++) {
        if (bytes[i] !== m.magic[i]) { ok = false; break }
      }
      if (ok) return m.label
    }
  }
  return null
}

export const hexHeaderParser: ResultParser = {
  id: 'hex-header',
  supports(input) {
    return input.toolId === 'hex' || input.manifestId === 'hex_header' || input.stepId === 'hex_header'
  },
  async parse(input: ParserInput): Promise<MaterializedResult> {
    if (!input.content) {
      return { observations: [], evidence: [], suggestedActions: [], flagCandidateDrafts: [], warnings: ['hex: no content'], rawArtifactIds: input.artifactIds }
    }
    const label = detectFromHex(input.content)
    if (!label) {
      return {
        observations: [{
          kind: 'file_magic',
          source: input.source,
          summary: 'no magic matched',
          confidence: 0.3,
        }],
        evidence: [],
        suggestedActions: [],
        flagCandidateDrafts: [],
        warnings: [],
        rawArtifactIds: input.artifactIds,
      }
    }
    return {
      observations: [{
        kind: 'file_magic',
        source: input.source,
        summary: label,
        attributes: { label },
        confidence: 0.85,
      }],
      evidence: [{
        kind: 'known_magic',
        claim: `file header matches ${label}`,
        confidence: 0.85,
        producer: { type: 'parser', id: 'hex-header' },
        polarity: 'supports',
      }],
      suggestedActions: [],
      flagCandidateDrafts: [],
      warnings: [],
      rawArtifactIds: input.artifactIds,
    }
  },
}