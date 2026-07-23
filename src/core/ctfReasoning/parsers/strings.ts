/**
 * StringsParser — Phase 2.1 §十四.
 *
 * Bounded strings extraction. Capped at MAX_STRINGS to prevent
 * flooding TaskState. Emits a printable_text Observation with preview,
 * keyword Evidence for notable markers, and FlagCandidate drafts.
 */

import type { ResultParser, ParserInput, MaterializedResult } from '../parserRegistry.js'
import { detectFlagLike, normalizeFlagValue } from '../flagCandidate.js'

const MIN_LENGTH = 4
const MAX_STRINGS = 200

const NOTABLE_KEYWORDS = ['password', 'secret', 'admin', 'flag', 'token', 'key', 'ctf']

export const stringsParser: ResultParser = {
  id: 'strings',
  supports(input) {
    return input.toolId === 'strings' || input.manifestId === 'strings' || input.stepId === 'strings'
  },
  async parse(input: ParserInput): Promise<MaterializedResult> {
    if (!input.content) {
      return { observations: [], evidence: [], suggestedActions: [], flagCandidateDrafts: [], warnings: ['strings: no content'], rawArtifactIds: input.artifactIds }
    }
    const lines = input.content.split('\n').filter((l) => l.length >= MIN_LENGTH)
    const keep = lines.slice(0, MAX_STRINGS)
    const flags: string[] = []
    const keywords = new Set<string>()
    for (const line of keep) {
      const f = detectFlagLike(line)
      if (f) flags.push(f)
      for (const k of NOTABLE_KEYWORDS) {
        if (line.toLowerCase().includes(k)) keywords.add(k)
      }
    }
    const observations: MaterializedResult['observations'] = [{
      kind: 'printable_text',
      source: input.source,
      summary: `${keep.length} printable string(s)`,
      attributes: { total: lines.length, kept: keep.length },
      confidence: 0.6,
    }]
    const evidence: MaterializedResult['evidence'] = []
    if (keywords.size > 0) {
      evidence.push({
        kind: 'generic',
        claim: `suspicious keywords present: ${[...keywords].slice(0, 5).join(', ')}`,
        confidence: 0.5,
        producer: { type: 'parser', id: 'strings' },
        polarity: 'neutral',
      })
    }
    const flagCandidateDrafts: MaterializedResult['flagCandidateDrafts'] = []
    for (const f of [...new Set(flags)]) {
      flagCandidateDrafts.push({
        value: f,
        normalizedValue: normalizeFlagValue(f),
        sourceObservationIds: [],
        sourceEvidenceIds: [],
        sourceArtifactIds: input.artifactIds,
        sourceRunIds: [],
        confidence: 0.7,
        producer: { type: 'parser', id: 'strings' },
      })
    }
    return {
      observations,
      evidence,
      suggestedActions: [],
      flagCandidateDrafts,
      warnings: lines.length > MAX_STRINGS ? [`strings: truncated ${lines.length - MAX_STRINGS} lines`] : [],
      rawArtifactIds: input.artifactIds,
    }
  },
}