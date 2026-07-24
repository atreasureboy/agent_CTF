export type ModelInvocationFailureKind =
  | 'routing_rejected'
  | 'role_denied'
  | 'capability_missing'
  | 'provider_unavailable'
  | 'provider_429'
  | 'provider_5xx'
  | 'timeout'
  | 'first_token_timeout'
  | 'stream_interrupted'
  | 'empty_response'
  | 'schema_failure'
  | 'tool_argument_failure'
  | 'cancelled'
  | 'consumer_cancelled'

export class NoEligibleModelError extends Error {
  public readonly role: string
  public readonly requiredCapabilities?: string[]
  public readonly rejectedModels: Array<{ modelId: string; reason: string }>

  constructor(details: {
    role: string
    requiredCapabilities?: string[]
    rejectedModels: Array<{ modelId: string; reason: string }>
  }) {
    const msg = `No eligible model found for role '${details.role}'. Rejected models: ${details.rejectedModels.map((m) => `${m.modelId} (${m.reason})`).join('; ')}`
    super(msg)
    this.name = 'NoEligibleModelError'
    this.role = details.role
    this.requiredCapabilities = details.requiredCapabilities
    this.rejectedModels = details.rejectedModels
  }
}

export class MissingModelProviderError extends Error {
  public readonly modelId: string
  public readonly providerId: string

  constructor(modelId: string, providerId: string) {
    const msg = `Missing ModelProvider for provider '${providerId}' (model '${modelId}'). No mock execution allowed in production.`
    super(msg)
    this.name = 'MissingModelProviderError'
    this.modelId = modelId
    this.providerId = providerId
  }
}
