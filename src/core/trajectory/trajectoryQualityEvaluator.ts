export interface TrajectoryStep {
  toolId: string
  input: Record<string, unknown>
  output: string
  exitCode?: number
  isError?: boolean
}

export interface EvaluatedTrajectoryStep extends TrajectoryStep {
  informationGainScore: number // 0.0 to 1.0
  isPruned: boolean
  processedOutput: string
}

export class TrajectoryQualityEvaluator {
  /**
   * Evaluate a trajectory step and assign information gain score.
   */
  public static evaluateStep(step: TrajectoryStep): EvaluatedTrajectoryStep {
    const raw = step.output ?? ''

    // Rule 1: High Error/Command Not Found Output -> Low Information Gain
    if (
      step.isError ||
      step.exitCode === 127 ||
      raw.includes('command not found') ||
      raw.includes('No such file or directory')
    ) {
      return {
        ...step,
        informationGainScore: 0.1,
        isPruned: true,
        processedOutput: `[Pruned Low-Gain Output]: Command failed or file not found (${raw.trim().slice(0, 100)})`,
      }
    }

    // Rule 2: Flag / Key Indicator Discovery -> Maximum Information Gain
    if (/flag\{[^}]+\}/i.test(raw) || /CTF\{[^}]+\}/i.test(raw) || raw.includes('PASSWORD:')) {
      return {
        ...step,
        informationGainScore: 1.0,
        isPruned: false,
        processedOutput: raw,
      }
    }

    // Rule 3: Extremely Long Redundant Raw Output (e.g. huge bin dumps) -> Truncate & Summarize Gain
    if (raw.length > 2000) {
      const head = raw.slice(0, 500)
      const tail = raw.slice(-500)
      return {
        ...step,
        informationGainScore: 0.6,
        isPruned: false,
        processedOutput: `${head}\n... [Truncated ${raw.length - 1000} bytes of noise by TrajectoryQualityEvaluator] ...\n${tail}`,
      }
    }

    // Default Normal Tool Output
    return {
      ...step,
      informationGainScore: 0.8,
      isPruned: false,
      processedOutput: raw,
    }
  }

  /**
   * Filter and prune a sequence of trajectory steps to maximize prompt context quality.
   */
  public static optimizeTrajectory(steps: TrajectoryStep[]): EvaluatedTrajectoryStep[] {
    return steps.map((s) => TrajectoryQualityEvaluator.evaluateStep(s))
  }
}
