import type { TrajectoryEventEnvelope } from './trajectoryTypes.js'

export interface TrajectoryValidationResult {
  valid: boolean
  totalEvents: number
  errors: Array<{ eventId?: string; rule: string; message: string }>
  warnings: Array<{ eventId?: string; rule: string; message: string }>
  scores: {
    commandFormat: number
    actionConsistency: number
    outputParsing: number
    completeness: number
    accuracy: number
    realism: number
  }
}

export class TrajectoryValidator {
  public static validateEnvelopes(
    envelopes: TrajectoryEventEnvelope[],
  ): TrajectoryValidationResult {
    const errors: Array<{ eventId?: string; rule: string; message: string }> = []
    const warnings: Array<{ eventId?: string; rule: string; message: string }> = []

    let commandFormatPass = 0
    let commandFormatTotal = 0

    let actionConsistencyPass = 0
    let actionConsistencyTotal = 0

    let timestampMonotonicPass = true

    let lastTimestamp = 0

    for (const env of envelopes) {
      if (env.schemaVersion !== '1.0') {
        errors.push({
          eventId: env.eventId,
          rule: 'schema_version',
          message: `Invalid schemaVersion '${env.schemaVersion}'. Expected '1.0'.`,
        })
      }

      if (env.timestamp < lastTimestamp) {
        timestampMonotonicPass = false
        errors.push({
          eventId: env.eventId,
          rule: 'realism',
          message: `Timestamp regression: current ${env.timestamp} < previous ${lastTimestamp}`,
        })
      }
      lastTimestamp = env.timestamp

      if (env.eventType === 'tool_call') {
        commandFormatTotal++
        const payload = env.payload as any
        if (payload?.toolId && payload?.attemptFingerprint) {
          commandFormatPass++
        } else {
          errors.push({
            eventId: env.eventId,
            rule: 'command_format',
            message: `Tool call event missing toolId or attemptFingerprint`,
          })
        }
      }

      if (env.eventType === 'suggested_action') {
        actionConsistencyTotal++
        const payload = env.payload as any
        if (payload?.actionName) {
          actionConsistencyPass++
        }
      }
    }

    const commandFormatScore = commandFormatTotal > 0 ? commandFormatPass / commandFormatTotal : 1.0
    const actionConsistencyScore =
      actionConsistencyTotal > 0 ? actionConsistencyPass / actionConsistencyTotal : 1.0
    const realismScore = timestampMonotonicPass ? 1.0 : 0.0

    return {
      valid: errors.length === 0,
      totalEvents: envelopes.length,
      errors,
      warnings,
      scores: {
        commandFormat: commandFormatScore,
        actionConsistency: actionConsistencyScore,
        outputParsing: 1.0,
        completeness: 1.0,
        accuracy: 1.0,
        realism: realismScore,
      },
    }
  }
}
