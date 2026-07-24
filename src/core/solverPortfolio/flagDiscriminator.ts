export interface FlagDiscriminationInput {
  candidateValue: string
  sourcePath?: string
  challengeCategory?: string
  expectedPattern?: RegExp | string
  locallyVerified?: boolean
  platformVerified?: boolean
}

export type FlagCandidateValidationStatus =
  | 'rejected'
  | 'syntax_match'
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
}

export class FlagDiscriminator {
  public static discriminate(input: FlagDiscriminationInput): FlagDiscriminationResult {
    const val = input.candidateValue.trim()
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
      }
    }

    if (input.expectedPattern) {
      const pattern =
        typeof input.expectedPattern === 'string'
          ? new RegExp(input.expectedPattern)
          : input.expectedPattern

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
        }
      }
    }

    const standardCtfRegex = /^[A-Za-z0-9_\-]+{[^{}\s]+}$/
    if (standardCtfRegex.test(val)) {
      return {
        valid: true,
        status: 'syntax_match',
        confidence: 0.95,
        reason: 'Flag matches standard CTF flag format syntax.',
        syntaxValid: true,
        provenanceValid: true,
        locallyValidated: false,
        platformAccepted: false,
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
    }
  }
}
