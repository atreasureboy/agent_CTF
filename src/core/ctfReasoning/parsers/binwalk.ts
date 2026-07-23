/**
 * BinwalkParser — Phase 2.1 §十四.
 *
 * Parses binwalk output rows (decimal offset, hex offset, signature).
 * Each signature becomes an embedded_data Observation + embedded_archive
 * Evidence + SuggestedAction to extract.
 */

import type { ResultParser, ParserInput, MaterializedResult } from '../parserRegistry.js'

const SIG_TO_KIND: Array<{ re: RegExp; kind: string; label: string }> = [
  { re: /zip archive/i, kind: 'zip', label: 'ZIP archive' },
  { re: /gzip/i, kind: 'gzip', label: 'GZIP' },
  { re: /png image/i, kind: 'png', label: 'PNG' },
  { re: /jpeg/i, kind: 'jpeg', label: 'JPEG' },
  { re: /7-zip/i, kind: '7z', label: '7z' },
  { re: /rar/i, kind: 'rar', label: 'RAR' },
  { re: /pdf document/i, kind: 'pdf', label: 'PDF' },
  { re: /elf /i, kind: 'elf', label: 'ELF' },
  { re: /pcap/i, kind: 'pcap', label: 'PCAP' },
]

export const binwalkParser: ResultParser = {
  id: 'binwalk',
  supports(input) {
    return input.toolId === 'binwalk' || input.manifestId === 'binwalk' || input.stepId === 'binwalk'
  },
  async parse(input: ParserInput): Promise<MaterializedResult> {
    if (!input.content) {
      return { observations: [], evidence: [], suggestedActions: [], flagCandidateDrafts: [], warnings: ['binwalk: no content'], rawArtifactIds: input.artifactIds }
    }
    const rows = input.content.split('\n').filter(Boolean)
    const re = /^(\d+)\s+(0x[0-9a-fA-F]+)\s+(.+)$/
    const observations: MaterializedResult['observations'] = []
    const evidence: MaterializedResult['evidence'] = []
    const actions: MaterializedResult['suggestedActions'] = []
    let matchCount = 0
    for (const row of rows) {
      const m = re.exec(row)
      if (!m) continue
      matchCount++
      const offset = m[2] ?? ''
      const sig = m[3] ?? ''
      const kind = SIG_TO_KIND.find((k) => k.re.test(sig))
      observations.push({
        kind: 'embedded_data',
        source: input.source,
        summary: `${kind?.label ?? sig} @ ${offset}`,
        attributes: { offset, signature: sig, kind: kind?.kind ?? 'unknown' },
        confidence: 0.8,
      })
      if (kind && (kind.kind === 'zip' || kind.kind === 'gzip' || kind.kind === '7z' || kind.kind === 'rar')) {
        evidence.push({
          kind: 'embedded_archive',
          claim: `${kind.label} embedded at ${offset}`,
          confidence: 0.85,
          producer: { type: 'parser', id: 'binwalk' },
          polarity: 'supports',
        })
        actions.push({
          type: 'call_tool',
          toolId: kind.kind === 'gzip' ? 'gunzip' : 'unzip',
          input: { offset, signature: sig },
          reason: `extract ${kind.label} at ${offset}`,
          priority: 5,
          costTier: 'cheap',
        })
      }
    }
    if (matchCount === 0) {
      evidence.push({
        kind: 'negative_result',
        claim: 'binwalk: no embedded signatures detected',
        confidence: 0.6,
        producer: { type: 'parser', id: 'binwalk' },
        polarity: 'neutral',
      })
    }
    return { observations, evidence, suggestedActions: actions, flagCandidateDrafts: [], warnings: [], rawArtifactIds: input.artifactIds }
  },
}