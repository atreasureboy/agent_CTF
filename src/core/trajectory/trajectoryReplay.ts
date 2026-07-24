import * as fs from 'node:fs'
import type { TrajectoryEventEnvelope } from './trajectoryTypes.js'
import type { TrajectoryValidationResult } from './trajectoryValidator.js';
import { TrajectoryValidator } from './trajectoryValidator.js'

export interface ReplayInput {
  trajectoryPath: string
  mode: 'validate-only' | 'state-rebuild' | 'mock-execution'
}

export interface ReplayResult {
  mode: string
  success: boolean
  eventsCount: number
  validationResult?: TrajectoryValidationResult
  rebuiltStateHash?: string
  mockExecutionConsistent?: boolean
}

export class TrajectoryReplay {
  public async replay(input: ReplayInput): Promise<ReplayResult> {
    if (!fs.existsSync(input.trajectoryPath)) {
      throw new Error(`Trajectory file '${input.trajectoryPath}' does not exist.`)
    }

    const content = await fs.promises.readFile(input.trajectoryPath, 'utf-8')
    const lines = content.split('\n').filter((l) => l.trim().length > 0)
    const envelopes: TrajectoryEventEnvelope[] = lines.map((l) => JSON.parse(l))

    const valResult = TrajectoryValidator.validateEnvelopes(envelopes)

    if (input.mode === 'validate-only') {
      return {
        mode: 'validate-only',
        success: valResult.valid,
        eventsCount: envelopes.length,
        validationResult: valResult,
      }
    }

    if (input.mode === 'state-rebuild') {
      const lastEvent = envelopes[envelopes.length - 1]
      return {
        mode: 'state-rebuild',
        success: valResult.valid,
        eventsCount: envelopes.length,
        validationResult: valResult,
        rebuiltStateHash: lastEvent?.payloadHash || 'empty_hash',
      }
    }

    // mock-execution mode
    return {
      mode: 'mock-execution',
      success: valResult.valid,
      eventsCount: envelopes.length,
      validationResult: valResult,
      mockExecutionConsistent: valResult.valid,
    }
  }
}
