/**
 * EncodingParser — Phase 2.1 §十四.
 *
 * Detects common text encodings from input shape:
 *   - Base16 (hex)   — only [0-9a-f]
 *   - Base32          — alphabet A-Z2-7
 *   - Base64          — alphabet A-Za-z0-9+/= (or url-safe)
 *   - Base85          — alphabet [!-u]
 *   - URL encoding    — %xx triplets
 *   - ROT13           — alpha only
 *
 * The parser does not DECODE — that's `encoding_sweep`'s job. It only
 * classifies so the Sweep workflow can pick the right codec.
 */

import type { ResultParser, ParserInput, MaterializedResult } from '../parserRegistry.js'

const RE = {
  base16: /^[0-9a-fA-F]+$/,
  base32: /^[A-Z2-7]+=*$/,
  base64: /^[A-Za-z0-9+/]+=*$|^[A-Za-z0-9\-_]+=*$/,
  base85: /^[!-u]+$/,
  urlEnc: /%(?:[0-9A-Fa-f]{2})/,
  rot13: /^[A-Za-z ]+$/,
}

function classify(s: string): string | null {
  if (s.length < 4) return null
  if (RE.base16.test(s)) return 'base16'
  if (RE.base32.test(s) && s.length % 8 === 0) return 'base32'
  if (RE.base64.test(s) && s.length % 4 === 0) {
    if (/[\-_]/.test(s)) return 'base64url'
    return 'base64'
  }
  if (RE.base85.test(s)) return 'base85'
  if (RE.urlEnc.test(s)) return 'url'
  if (RE.rot13.test(s) && s.length > 8) return 'rot13'
  return null
}

export const encodingParser: ResultParser = {
  id: 'encoding',
  supports(input) {
    return input.toolId === 'encoding-detect' || input.manifestId === 'encoding' || input.stepId === 'encoding'
  },
  async parse(input: ParserInput): Promise<MaterializedResult> {
    if (!input.content) {
      return { observations: [], evidence: [], suggestedActions: [], flagCandidateDrafts: [], warnings: ['encoding: no content'], rawArtifactIds: input.artifactIds }
    }
    const codec = classify(input.content.trim())
    if (!codec) {
      return {
        observations: [{
          kind: 'encoding_result',
          source: input.source,
          summary: 'no common encoding detected',
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
        kind: 'encoding_result',
        source: input.source,
        summary: `looks like ${codec}`,
        attributes: { codec },
        confidence: 0.7,
      }],
      evidence: [{
        kind: 'encoding_layer',
        claim: `input is ${codec} encoded`,
        confidence: 0.7,
        producer: { type: 'parser', id: 'encoding' },
        polarity: 'supports',
      }],
      suggestedActions: [{
        type: 'run_workflow',
        workflowId: 'encoding_sweep',
        inputs: { codec, content: input.content.slice(0, 4096) },
        reason: `decode ${codec} layer via encoding_sweep`,
        priority: 6,
        costTier: 'cheap',
      }],
      flagCandidateDrafts: [],
      warnings: [],
      rawArtifactIds: input.artifactIds,
    }
  },
}