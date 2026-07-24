export interface FlagDiscriminationInput {
  candidateValue: string
  sourcePath?: string
  challengeCategory?: string
  expectedPattern?: RegExp | string
}

export interface FlagDiscriminationResult {
  valid: boolean
  confidence: number
  reason: string
}

export class FlagDiscriminator {
  public static discriminate(input: FlagDiscriminationInput): FlagDiscriminationResult {
    const val = input.candidateValue.trim()
    if (!val) {
      return { valid: false, confidence: 0, reason: 'Candidate value is empty' }
    }

    if (input.expectedPattern) {
      const pattern =
        typeof input.expectedPattern === 'string'
          ? new RegExp(input.expectedPattern)
          : input.expectedPattern

      if (!pattern.test(val)) {
        return {
          valid: false,
          confidence: 0.1,
          reason: `Flag '${val}' does not match expected pattern '${pattern.source}'`,
        }
      }
    }

    // Standard CTF flag format heuristic check (e.g. flag{...}, CTF{...}, etc.)
    const standardCtfRegex = /^[A-Za-z0-9_\-]+{[^{}\s]+}$/
    if (standardCtfRegex.test(val)) {
      return {
        valid: true,
        confidence: 0.95,
        reason: 'Flag matches standard CTF flag format syntax.',
      }
    }

    // Reject obvious plain text words / log messages that do not look like flags
    if (/^[a-z_]+$/.test(val) && !val.includes('{')) {
      return {
        valid: false,
        confidence: 0.1,
        reason: 'Plain text string without flag format wrapper rejected.',
      }
    }

    return {
      valid: true,
      confidence: 0.6,
      reason: 'Flag format unconfirmed by strict regex, but passes basic candidate check.',
    }
  }
}
