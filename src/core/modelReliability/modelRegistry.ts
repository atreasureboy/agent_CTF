import {
  DEFAULT_CONSERVATIVE_PROFILE,
  ModelCapabilityProfile,
  ModelCapabilityProfileSchema,
} from './modelCapability.js'

export class ModelCapabilityRegistry {
  private profiles = new Map<string, ModelCapabilityProfile>()

  constructor(initialProfiles: ModelCapabilityProfile[] = []) {
    for (const p of initialProfiles) {
      this.registerProfile(p)
    }
    // Register standard builtin profiles if empty
    if (this.profiles.size === 0) {
      this.registerDefaults()
    }
  }

  public registerProfile(profile: ModelCapabilityProfile): void {
    const validated = ModelCapabilityProfileSchema.parse(profile)
    this.profiles.set(validated.id, validated)
  }

  public getProfile(modelId: string): ModelCapabilityProfile {
    const p = this.profiles.get(modelId)
    if (p) return p
    // Return conservative profile dynamically for unknown models
    return {
      ...DEFAULT_CONSERVATIVE_PROFILE,
      id: modelId,
      model: modelId,
    }
  }

  public hasProfile(modelId: string): boolean {
    return this.profiles.has(modelId)
  }

  public listProfiles(): ModelCapabilityProfile[] {
    return Array.from(this.profiles.values())
  }

  private registerDefaults(): void {
    // High-capacity tier model profile (e.g. codex-tier)
    this.registerProfile({
      id: 'high-tier-model',
      provider: 'openai',
      model: 'gpt-4o',
      contextWindow: 128000,
      capabilities: {
        toolCalling: true,
        structuredOutput: true,
        vision: true,
        longContext: true,
        codeExecutionPlanning: true,
      },
      reliability: {
        structuredOutput: 0.98,
        toolArguments: 0.95,
        longHorizonPlanning: 0.92,
        summarization: 0.95,
        instructionFollowing: 0.96,
      },
      economics: {
        inputCostPerMillion: 2.5,
        outputCostPerMillion: 10.0,
        expectedLatencyMs: 1500,
      },
      allowedRoles: [
        'competition_coordinator',
        'task_planner',
        'solver_scout',
        'deep_solver',
        'context_compiler',
        'progress_summarizer',
        'specialist',
        'flag_discriminator',
        'reporter',
      ],
      limits: {
        maxVisibleTools: 50,
        maxIterations: 30,
        maxRepairAttempts: 2,
        maxConsecutiveFailures: 3,
      },
      fallbackModelIds: [],
    })

    // Low-cost / auxiliary tier model profile (e.g. M3 tier)
    this.registerProfile({
      id: 'm3-low-cost-tier',
      provider: 'local-or-aux',
      model: 'm3-mini',
      contextWindow: 32768,
      capabilities: {
        toolCalling: true,
        structuredOutput: true,
        vision: false,
        longContext: false,
        codeExecutionPlanning: false,
      },
      reliability: {
        structuredOutput: 0.8,
        toolArguments: 0.75,
        longHorizonPlanning: 0.6,
        summarization: 0.85,
        instructionFollowing: 0.8,
      },
      economics: {
        inputCostPerMillion: 0.2,
        outputCostPerMillion: 0.6,
        expectedLatencyMs: 800,
      },
      allowedRoles: [
        'solver_scout',
        'progress_summarizer',
        'context_compiler',
        'specialist',
      ],
      limits: {
        maxVisibleTools: 12,
        maxIterations: 10,
        maxRepairAttempts: 1,
        maxConsecutiveFailures: 2,
      },
      fallbackModelIds: ['high-tier-model'],
    })
  }
}
