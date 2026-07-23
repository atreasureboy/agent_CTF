/**
 * ZstegParser — Phase 2.1 §十四.
 *
 * Distinguishes:
 *   - high-quality text (printable ASCII > 8 chars)
 *   - known file signatures (PNG / PDF / etc)
 *   - binary noise (everything else)
 *   - no meaningful result (empty output)
 */

import type { ResultParser, ParserInput, MaterializedResult } from '../parserRegistry.js'
import { detectFlagLike, normalizeFlagValue } from '../flagCandidate.js'

const ROW_RE = /^\s*([\w.,]+)\s+(\.\.|file|text|zip|RGBA|raw|bmp)\s*:\s*"?([^"\n]*)"?/

const KNOWN_FILE_SIGS = ['PNG image', 'JFIF', 'PDF document', 'ZIP archive']

export const zstegParser: ResultParser = {
  id: 'zsteg',
  supports(input) {
    return input.toolId === 'zsteg' || input.manifestId === 'zsteg' || input.stepId === 'zsteg'
  },
  async parse(input: ParserInput): Promise<MaterializedResult> {
    if (!input.content || input.content.trim() === '') {
      return {
        observations: [{
          kind: 'negative_result',
          source: input.source,
          summary: 'zsteg: no meaningful result',
          confidence: 0.7,
        }],
        evidence: [{
          kind: 'negative_result',
          claim: 'image does not appear to contain steganographic payload',
          confidence: 0.6,
          producer: { type: 'parser', id: 'zsteg' },
          polarity: 'neutral',
        }],
        suggestedActions: [],
        flagCandidateDrafts: [],
        warnings: ['zsteg: empty'],
        rawArtifactIds: input.artifactIds,
      }
    }
    const rows = input.content.split('\n').filter(Boolean)
    const observations: MaterializedResult['observations'] = []
    const evidence: MaterializedResult['evidence'] = []
    const flagCandidateDrafts: MaterializedResult['flagCandidateDrafts'] = []
    let highQuality = 0
    let binaryNoise = 0
    let fileSig = 0
    for (const row of rows) {
      const m = ROW_RE.exec(row)
      if (!m) continue
      const channel = m[1] ?? ''
      const kind = m[2] ?? ''
      const value = m[3] ?? ''
      if (KNOWN_FILE_SIGS.some((s) => value.includes(s))) {
        fileSig++
        observations.push({
          kind: 'image_property',
          source: input.source,
          summary: `zsteg ${channel}: ${value}`,
          confidence: 0.8,
        })
        continue
      }
      if (value.length >= 8 && /^[A-Za-z0-9 _.,!?'"-]+$/.test(value)) {
        highQuality++
        observations.push({
          kind: 'printable_text',
          source: input.source,
          summary: `zsteg ${channel} ${kind}: ${value.slice(0, 80)}`,
          attributes: { channel, kind, value },
          confidence: 0.7,
        })
        const flag = detectFlagLike(value)
        if (flag) {
          flagCandidateDrafts.push({
            value: flag,
            normalizedValue: normalizeFlagValue(flag),
            sourceObservationIds: [],
            sourceEvidenceIds: [],
            sourceArtifactIds: input.artifactIds,
            sourceRunIds: [],
            confidence: 0.8,
            producer: { type: 'parser', id: 'zsteg' },
          })
          evidence.push({
            kind: 'flag_candidate_source',
            claim: 'stego channel produced a flag-like string',
            confidence: 0.75,
            producer: { type: 'parser', id: 'zsteg' },
            polarity: 'supports',
          })
        }
      } else {
        binaryNoise++
      }
    }
    if (highQuality === 0 && fileSig === 0) {
      evidence.push({
        kind: 'negative_result',
        claim: 'zsteg: no meaningful channels',
        confidence: 0.5,
        producer: { type: 'parser', id: 'zsteg' },
        polarity: 'neutral',
      })
    }
    return {
      observations,
      evidence,
      suggestedActions: highQuality > 0 ? [{
        type: 'call_tool',
        toolId: 'image-stego',
        input: { channels: highQuality },
        reason: 'zsteg produced high-quality text — escalate to image-stego specialist',
        priority: 4,
        costTier: 'normal',
      }] : [],
      flagCandidateDrafts,
      warnings: [],
      rawArtifactIds: input.artifactIds,
      metrics: { outputBytes: input.content.length },
    }
  },
}