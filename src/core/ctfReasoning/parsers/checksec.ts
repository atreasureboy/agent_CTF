/**
 * ChecksecParser — Phase 2.1 §十四.
 *
 * Parses `checksec --output=json` or column-formatted output into
 * structured binary_protection attributes.
 */

import type { ResultParser, ParserInput, MaterializedResult } from '../parserRegistry.js'

const ATTR_RE = /^\s*(RELRO|STACK CANARY|NX|PIE|RPATH|RUNPATH|FORTIFY|STRIPPED|ARCH|CANARY)\s*[:=]\s*(.+?)\s*$/i

const ATTR_MAP: Record<string, string> = {
  RELRO: 'relro',
  'STACK CANARY': 'canary',
  CANARY: 'canary',
  NX: 'nx',
  PIE: 'pie',
  RPATH: 'rpath',
  RUNPATH: 'runpath',
  FORTIFY: 'fortify',
  STRIPPED: 'stripped',
  ARCH: 'arch',
}

export const checksecParser: ResultParser = {
  id: 'checksec',
  supports(input) {
    return input.toolId === 'checksec' || input.manifestId === 'checksec' || input.stepId === 'checksec'
  },
  async parse(input: ParserInput): Promise<MaterializedResult> {
    if (!input.content) {
      return { observations: [], evidence: [], suggestedActions: [], flagCandidateDrafts: [], warnings: ['checksec: no content'], rawArtifactIds: input.artifactIds }
    }
    const attrs: Record<string, string> = {}
    for (const row of input.content.split('\n')) {
      const m = ATTR_RE.exec(row)
      if (!m) continue
      const k = ATTR_MAP[m[1]?.toUpperCase() ?? '']
      if (k) attrs[k] = m[2] ?? ''
    }
    const observations: MaterializedResult['observations'] = [{
      kind: 'binary_protection',
      source: input.source,
      summary: Object.keys(attrs).length > 0
        ? `protections: ${Object.entries(attrs).map(([k, v]) => `${k}=${v}`).join(', ')}`
        : 'no protections parsed',
      attributes: attrs,
      confidence: 0.9,
    }]
    const evidence: MaterializedResult['evidence'] = []
    if (Object.keys(attrs).length > 0) {
      evidence.push({
        kind: 'binary_protection',
        claim: 'binary protection summary extracted',
        polarity: 'neutral',
        source: {
          producer: { type: 'parser', id: 'checksec' },
          observationIds: [], artifactIds: input.artifactIds, attemptIds: [],
          confidence: 0.9, createdAt: Date.now(),
        },
      })
    }
    return { observations, evidence, suggestedActions: [], flagCandidateDrafts: [], warnings: [], rawArtifactIds: input.artifactIds }
  },
}