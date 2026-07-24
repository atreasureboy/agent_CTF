/**
 * FlagDetector + Validator — Phase 2.1 §二十八.
 *
 * The detector classifies text into a FlagCandidateDraft with the
 * supporting observation/evidence ids attached. The validator runs the
 * canonical 3-gate check:
 *   - patternMatched
 *   - provenanceComplete
 *   - locallyVerified
 *
 * A candidate is only `validated` when ALL three pass. This file does
 * not submit to any real platform.
 */

import type { FlagCandidateDraft } from './flagCandidate.js'
import { detectFlagLike, normalizeFlagValue } from './flagCandidate.js'

export interface FlagDetectionInput {
  text: string
  sourceObservationIds: string[]
  sourceEvidenceIds: string[]
  sourceArtifactIds: string[]
  sourceRunIds: string[]
  challengeFlagPattern?: string
  producer: FlagCandidateDraft['producer']
}

export interface FlagDetectionResult {
  detected: boolean
  draft?: FlagCandidateDraft
  reason?: 'no_match'
}

export function detectFlag(input: FlagDetectionInput): FlagDetectionResult {
  if (!input.text) return { detected: false, reason: 'no_match' }
  const direct = detectFlagLike(input.text)
  let matched = direct
  if (!matched && input.challengeFlagPattern) {
    try {
      const re = new RegExp(input.challengeFlagPattern, 'i')
      const m = re.exec(input.text)
      if (m) matched = m[0]
    } catch {
      // invalid challenge pattern — ignore
    }
  }
  if (!matched) return { detected: false, reason: 'no_match' }
  const draft: FlagCandidateDraft = {
    value: matched,
    normalizedValue: normalizeFlagValue(matched),
    sourceObservationIds: input.sourceObservationIds,
    sourceEvidenceIds: input.sourceEvidenceIds,
    sourceArtifactIds: input.sourceArtifactIds,
    sourceRunIds: input.sourceRunIds,
    confidence: 0.6,
    producer: input.producer,
  }
  return { detected: true, draft }
}

export interface FlagValidationInput {
  pattern: string
  /** The actual candidate value to test the pattern against. §round-3
   *  audit fix — without this, `patternMatched` was a smoke test of
   *  the regex against its own pattern string, not the candidate. */
  candidate: string
  provenanceComplete: boolean
  sourceArtifactExists: boolean
  locallyVerified?: boolean
}

export interface FlagValidationResult {
  validated: boolean
  patternMatched: boolean
  locallyVerified: boolean
  errors: string[]
}

export function validateFlag(input: FlagValidationInput): FlagValidationResult {
  const errors: string[] = []
  let patternMatched = false
  try {
    // §round-3 audit fix — apply the pattern to the actual candidate.
    patternMatched = new RegExp(input.pattern, 'i').test(input.candidate)
  } catch {
    errors.push('invalid pattern')
  }
  if (!patternMatched) errors.push('pattern mismatch')
  if (!input.provenanceComplete) errors.push('provenance incomplete')
  if (!input.sourceArtifactExists) errors.push('source artifact missing')
  const locallyVerified = input.locallyVerified ?? errors.length === 0
  return {
    validated: errors.length === 0 && locallyVerified,
    patternMatched,
    locallyVerified,
    errors,
  }
}
