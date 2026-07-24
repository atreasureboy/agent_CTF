import type {
  ModelCapabilityProfile} from './modelCapability.js';
import {
  DEFAULT_CONSERVATIVE_PROFILE,
  ModelCapabilityProfileSchema,
} from './modelCapability.js'
import type { ModelProfileResolver } from './structuredModelGateway.js'

export interface RuntimeModelConfiguration {
  providers?: Array<{ id: string; name: string; type: string }>
  models: ModelCapabilityProfile[]
}

export class ModelCapabilityRegistry implements ModelProfileResolver {
  private profiles = new Map<string, ModelCapabilityProfile>()

  constructor(initialProfiles: ModelCapabilityProfile[] = []) {
    for (const p of initialProfiles) {
      this.registerProfile(p)
    }
    if (this.profiles.size === 0) {
      this.registerDefaults()
    }
  }

  public registerProfile(profile: ModelCapabilityProfile): void {
    const validated = ModelCapabilityProfileSchema.parse(profile)
    this.profiles.set(validated.id, validated)
  }

  public registerConfiguration(config: RuntimeModelConfiguration): void {
    for (const model of config.models) {
      this.registerProfile(model)
    }
  }

  public getRequired(modelId: string): ModelCapabilityProfile {
    const p = this.profiles.get(modelId)
    if (!p) {
      throw new Error(`ModelCapabilityProfile for model '${modelId}' not found in registry.`)
    }
    return p
  }

  public getProfile(modelId: string): ModelCapabilityProfile {
    const p = this.profiles.get(modelId)
    if (p) return p
    return {
      ...DEFAULT_CONSERVATIVE_PROFILE,
      id: modelId,
      model: modelId,
      providerId: 'openai',
      providerModelName: modelId,
      provider: 'openai',
    }
  }

  public hasProfile(modelId: string): boolean {
    return this.profiles.has(modelId)
  }

  public listProfiles(): ModelCapabilityProfile[] {
    return Array.from(this.profiles.values())
  }

  private registerDefaults(): void {
    this.registerProfile({
      id: 'high-tier-model',
      providerId: 'openai',
      providerModelName: 'gpt-4o',
      provider: 'openai',
      model: 'gpt-4o',
      trustLevel: 'privileged',
      reliabilityClass: 'privileged',
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

    this.registerProfile({
      id: 'gpt-4o',
      providerId: 'openai',
      providerModelName: 'gpt-4o',
      provider: 'openai',
      model: 'gpt-4o',
      trustLevel: 'privileged',
      reliabilityClass: 'privileged',
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

    this.registerProfile({
      id: 'm3-low-cost-tier',
      providerId: 'local-or-aux',
      providerModelName: 'm3-mini',
      provider: 'local-or-aux',
      model: 'm3-mini',
      trustLevel: 'auxiliary',
      reliabilityClass: 'auxiliary',
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
      allowedRoles: ['solver_scout', 'progress_summarizer', 'context_compiler', 'specialist'],
      limits: {
        maxVisibleTools: 12,
        maxIterations: 10,
        maxRepairAttempts: 1,
        maxConsecutiveFailures: 2,
      },
      fallbackModelIds: ['high-tier-model', 'gpt-4o'],
    })
  }
}
