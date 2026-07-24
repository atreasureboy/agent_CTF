export interface FlagDiscriminationInput {
  taskId?: string
  candidateId?: string
  candidateValue: string
  value?: string
  sourcePath?: string
  challengeCategory?: string
  expectedPattern?: RegExp | string
  challengePattern?: string
  locallyVerified?: boolean
  platformVerified?: boolean
  sourceObservationIds?: string[]
  sourceEvidenceIds?: string[]
  sourceArtifactIds?: string[]
  sourceAttemptIds?: string[]
  transformChain?: Array<{ type: string; details?: string }>
  localFixtureExpectedHash?: string
}

export type FlagCandidateValidationStatus =
  | 'rejected'
  | 'syntax_match'
  | 'provenance_valid'
  | 'inconclusive'
  | 'locally_validated'
  | 'platform_accepted'

export interface FlagDiscriminationResult {
  valid: boolean
  status: FlagCandidateValidationStatus
  confidence: number
  reason: string
  syntaxValid: boolean
  provenanceValid: boolean
  locallyValidated: boolean
  platformAccepted: boolean
  canCancelOtherSolvers: boolean
}

export class FlagDiscriminator {
  public static discriminate(input: FlagDiscriminationInput): FlagDiscriminationResult {
    const rawVal = input.value || input.candidateValue || ''
    const val = rawVal.trim()

    if (!val) {
      return {
        valid: false,
        status: 'rejected',
        confidence: 0,
        reason: 'Candidate value is empty',
        syntaxValid: false,
        provenanceValid: false,
        locallyValidated: false,
        platformAccepted: false,
        canCancelOtherSolvers: false,
      }
    }

    if (input.platformVerified) {
      return {
        valid: true,
        status: 'platform_accepted',
        confidence: 1.0,
        reason: 'Flag verified accepted by platform.',
        syntaxValid: true,
        provenanceValid: true,
        locallyValidated: true,
        platformAccepted: true,
        canCancelOtherSolvers: true,
      }
    }

    if (input.locallyVerified) {
      return {
        valid: true,
        status: 'locally_validated',
        confidence: 0.99,
        reason: 'Flag verified locally against local challenge test/harness.',
        syntaxValid: true,
        provenanceValid: true,
        locallyValidated: true,
        platformAccepted: false,
        canCancelOtherSolvers: true,
      }
    }

    const hasProvenance =
      (input.sourceObservationIds && input.sourceObservationIds.length > 0) ||
      (input.sourceEvidenceIds && input.sourceEvidenceIds.length > 0) ||
      (input.sourceArtifactIds && input.sourceArtifactIds.length > 0)

    const expectedPat = input.expectedPattern || input.challengePattern
    if (expectedPat) {
      const pattern = typeof expectedPat === 'string' ? new RegExp(expectedPat) : expectedPat

      if (!pattern.test(val)) {
        return {
          valid: false,
          status: 'rejected',
          confidence: 0.1,
          reason: `Flag '${val}' does not match expected pattern '${pattern.source}'`,
          syntaxValid: false,
          provenanceValid: false,
          locallyValidated: false,
          platformAccepted: false,
          canCancelOtherSolvers: false,
        }
      }
    }

    const standardCtfRegex = /^[A-Za-z0-9_\-]+{[^{}\s]+}$/
    if (standardCtfRegex.test(val)) {
      if (hasProvenance) {
        return {
          valid: true,
          status: 'provenance_valid',
          confidence: 0.96,
          reason: 'Flag matches CTF format syntax and has verified source provenance.',
          syntaxValid: true,
          provenanceValid: true,
          locallyValidated: false,
          platformAccepted: false,
          canCancelOtherSolvers: false, // Syntax + provenance valid is NOT enough to cancel without local/platform validation
        }
      }
      return {
        valid: true,
        status: 'syntax_match',
        confidence: 0.85,
        reason: 'Flag matches standard CTF flag format syntax.',
        syntaxValid: true,
        provenanceValid: false,
        locallyValidated: false,
        platformAccepted: false,
        canCancelOtherSolvers: false, // Syntax match alone CANNOT cancel other solvers
      }
    }

    if (/^[a-z_]+$/.test(val) && !val.includes('{')) {
      return {
        valid: false,
        status: 'rejected',
        confidence: 0.1,
        reason: 'Plain text string without flag format wrapper rejected.',
        syntaxValid: false,
        provenanceValid: false,
        locallyValidated: false,
        platformAccepted: false,
        canCancelOtherSolvers: false,
      }
    }

    return {
      valid: true,
      status: 'inconclusive',
      confidence: 0.5,
      reason: 'Flag format unconfirmed by strict regex, marked inconclusive.',
      syntaxValid: false,
      provenanceValid: false,
      locallyValidated: false,
      platformAccepted: false,
      canCancelOtherSolvers: false,
    }
  }
}
