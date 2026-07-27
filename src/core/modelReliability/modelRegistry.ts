import type {
  ModelCapabilityProfile} from './modelCapability.js';
import {
  DEFAULT_CONSERVATIVE_PROFILE,
  ModelCapabilityProfileSchema,
} from './modelCapability.js'
import type { ModelProfileResolver } from './structuredModelGateway.js'

export interface ProviderConfiguration {
  id: string
  name: string
  type: string
}

export interface RuntimeModelConfiguration {
  providers?: ProviderConfiguration[]
  models: ModelCapabilityProfile[]
}

export function validateModelRuntimeConfiguration(config: RuntimeModelConfiguration): {
  valid: boolean
  errors: string[]
} {
  const errors: string[] = []
  const modelIds = new Set<string>()
  const providerIds = new Set<string>((config.providers ?? []).map((p) => p.id))

  for (const p of config.providers ?? []) {
    if (!p.id) errors.push('Provider missing ID')
  }

  for (const model of config.models) {
    if (modelIds.has(model.id)) {
      errors.push(`Duplicate model ID: ${model.id}`)
    }
    modelIds.add(model.id)

    if (!model.providerModelName) {
      errors.push(`Model '${model.id}' has empty providerModelName`)
    }

    const pId = model.providerId || model.provider
    if (config.providers && config.providers.length > 0 && !providerIds.has(pId)) {
      errors.push(`Model '${model.id}' references missing providerId '${pId}'`)
    }

    for (const fbId of model.fallbackModelIds) {
      const fbModel = config.models.find((m) => m.id === fbId)
      if (!fbModel) {
        errors.push(`Model '${model.id}' references non-existent fallback model '${fbId}'`)
      } else {
        const fbPId = fbModel.providerId || fbModel.provider
        if (config.providers && config.providers.length > 0 && !providerIds.has(fbPId)) {
          errors.push(
            `Fallback model '${fbId}' for model '${model.id}' references missing providerId '${fbPId}'`,
          )
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  }
}

export class ModelCapabilityRegistry implements ModelProfileResolver {
  private profiles = new Map<string, ModelCapabilityProfile>()

  constructor(initialProfiles: ModelCapabilityProfile[] = []) {
    for (const p of initialProfiles) {
      this.registerProfile(p)
    }
  }

  public registerProfile(profile: ModelCapabilityProfile): void {
    const validated = ModelCapabilityProfileSchema.parse(profile)
    this.profiles.set(validated.id, validated)
  }

  public registerConfiguration(config: RuntimeModelConfiguration): void {
    const validation = validateModelRuntimeConfiguration(config)
    if (!validation.valid) {
      throw new Error(
        `Invalid RuntimeModelConfiguration: ${validation.errors.join('; ')}`,
      )
    }
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
    return this.getRequired(modelId)
  }

  public hasProfile(modelId: string): boolean {
    return this.profiles.has(modelId)
  }

  public listProfiles(): ModelCapabilityProfile[] {
    return Array.from(this.profiles.values())
  }
}

