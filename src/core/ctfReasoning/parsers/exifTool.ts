/**
 * ExifToolParser — Phase 2.1 §十四.
 *
 * Extracts key fields from `exiftool` output. Suspect fields (long
 * values, embedded URLs, comments) get an Evidence + Observation.
 */

import type { ResultParser, ParserInput, MaterializedResult } from '../parserRegistry.js'

const SUSPECT_KEYS = ['Comment', 'Description', 'UserComment', 'Software', 'Author', 'Creator', 'Artist', 'Copyright']
const LONG_VALUE_THRESHOLD = 256

const FIELD_RE = /^\s*([A-Za-z][A-Za-z0-9 _-]*?)\s*:\s+(.+?)\s*$/

export const exifToolParser: ResultParser = {
  id: 'exiftool',
  supports(input) {
    return input.toolId === 'exiftool' || input.manifestId === 'exiftool' || input.stepId === 'exiftool'
  },
  async parse(input: ParserInput): Promise<MaterializedResult> {
    if (!input.content) {
      return { observations: [], evidence: [], suggestedActions: [], flagCandidateDrafts: [], warnings: ['exiftool: no content'], rawArtifactIds: input.artifactIds }
    }
    const observations: MaterializedResult['observations'] = []
    const evidence: MaterializedResult['evidence'] = []
    const suspect: Array<{ key: string; value: string }> = []
    for (const row of input.content.split('\n')) {
      const m = FIELD_RE.exec(row)
      if (!m) continue
      const key = m[1]?.trim() ?? ''
      const value = m[2]?.trim() ?? ''
      if (SUSPECT_KEYS.includes(key) || value.length > LONG_VALUE_THRESHOLD) {
        suspect.push({ key, value })
      }
    }
    if (suspect.length === 0) {
      return {
        observations: [],
        evidence: [{
          kind: 'negative_result',
          claim: 'exiftool: no suspicious metadata fields',
          confidence: 0.6,
          producer: { type: 'parser', id: 'exiftool' },
          polarity: 'neutral',
        }],
        suggestedActions: [],
        flagCandidateDrafts: [],
        warnings: [],
        rawArtifactIds: input.artifactIds,
      }
    }
    for (const s of suspect) {
      observations.push({
        kind: 'metadata',
        source: input.source,
        summary: `${s.key}: ${s.value.slice(0, 80)}`,
        attributes: { key: s.key, valueLength: s.value.length },
        confidence: 0.6,
        rawExcerpt: s.value.slice(0, 512),
      })
      if (s.value.length > LONG_VALUE_THRESHOLD) {
        evidence.push({
          kind: 'suspicious_metadata',
          claim: `${s.key} is unusually long (${s.value.length} chars)`,
          confidence: 0.65,
          producer: { type: 'parser', id: 'exiftool' },
          polarity: 'supports',
        })
      }
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