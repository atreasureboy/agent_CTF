import type { z } from 'zod'
import type OpenAI from 'openai'

import type { ModelCapabilityProfile, ModelRole } from './modelCapability.js'
import type { ModelCircuitBreaker } from './modelCircuitBreaker.js'
import type { ModelHealthStore } from './modelHealth.js'
import { ModelRolePolicy } from './modelRolePolicy.js'
import type { ModelRouter, ModelRoutingDecision } from './modelRouter.js'
import type { ModelProvider } from './providers/modelProvider.js'
import { MissingModelProviderError } from './errors.js'
import type { TrajectoryRecorder } from '../trajectory/trajectoryRecorder.js'
import { MonitoredAgentTurnStream } from './monitoredStream.js'

export interface ModelProfileResolver {
  getRequired(modelId: string): ModelCapabilityProfile
  getProfile(modelId: string): ModelCapabilityProfile
}

export interface AgentTurnModelRequest {
  taskId: string
  agentRunId?: string

  role: ModelRole
  preferredModelId?: string

  messages: OpenAI.Chat.ChatCompletionMessageParam[]
  tools?: OpenAI.Chat.ChatCompletionTool[]

  temperature?: number
  maxOutputTokens?: number

  requiredCapabilities?: string[]

  signal?: AbortSignal
}

export interface StructuredModelRequest<T> {
  role: ModelRole
  preferredModelId?: string
  systemPrompt: string
  userPrompt: string
  outputSchema: z.ZodType<T>
  tools?: any[]
  taskId: string
  agentRunId?: string
  signal?: AbortSignal
  maxRepairRawChars?: number
  llmExecutor?: (
    modelId: string,
    systemPrompt: string,
    userPrompt: string,
  ) => Promise<{ rawText: string; usage?: { inputTokens: number; outputTokens: number } }>
}

export interface StructuredModelResponse<T> {
  modelId: string
  value: T
  repaired: boolean
  fallbackUsed: boolean
  usage?: { inputTokens: number; outputTokens: number }
  durationMs: number
  routingDecision: ModelRoutingDecision
}

export interface ModelInvocationGateway {
  streamAgentTurn(
    input: AgentTurnModelRequest,
  ): Promise<AsyncIterable<OpenAI.Chat.ChatCompletionChunk>>

  executeStructured<T>(input: StructuredModelRequest<T>): Promise<StructuredModelResponse<T>>
}

export class StructuredModelGateway implements ModelInvocationGateway {
  private router: ModelRouter
  private healthStore: ModelHealthStore
  private circuitBreaker: ModelCircuitBreaker
  private profileResolver?: ModelProfileResolver
  private trajectoryRecorder?: TrajectoryRecorder
  private getRevisionFn?: (taskId: string) => number
  private providers = new Map<string, ModelProvider>()

  constructor(
    router: ModelRouter,
    healthStore: ModelHealthStore,
    circuitBreaker: ModelCircuitBreaker,
    profileResolver?: ModelProfileResolver,
    trajectoryRecorder?: TrajectoryRecorder,
    getRevisionFn?: (taskId: string) => number,
  ) {
    this.router = router
    this.healthStore = healthStore
    this.circuitBreaker = circuitBreaker
    this.profileResolver = profileResolver
    this.trajectoryRecorder = trajectoryRecorder
    this.getRevisionFn = getRevisionFn
  }

  public registerProvider(provider: ModelProvider): void {
    this.providers.set(provider.id, provider)
  }

  public getProvider(id: string): ModelProvider | undefined {
    return this.providers.get(id)
  }

  public hasProvider(id: string): boolean {
    return this.providers.has(id)
  }

  public getRevision(taskId: string): number {
    return this.getRevisionFn ? this.getRevisionFn(taskId) : 1
  }

  public async streamAgentTurn(
    req: AgentTurnModelRequest,
  ): Promise<AsyncIterable<OpenAI.Chat.ChatCompletionChunk>> {
    const routingDecision = this.router.route({
      role: req.role,
      preferredModelId: req.preferredModelId,
      requiredCapabilities: req.requiredCapabilities,
      taskId: req.taskId,
      hasProvider: (pId) => {
        if (this.providers.size === 0) return true
        return (
          this.providers.has(pId) ||
          Array.from(this.providers.values()).some((p) => p.id.includes(pId) || pId.includes(p.id))
        )
      },
    })

    this.trajectoryRecorder?.record(
      req.taskId,
      'model_routing_decision',
      {
        selectedModelId: routingDecision.selectedModelId,
        reason: routingDecision.reason,
        role: req.role,
        mode: 'streaming',
      },
      this.getRevision(req.taskId),
      req.agentRunId,
    )

    const candidateModels = [routingDecision.selectedModelId, ...routingDecision.fallbackModelIds]

    let lastError: Error | null = null

    for (let i = 0; i < candidateModels.length; i++) {
      const activeModelId = candidateModels[i]

      const modelProfile = this.profileResolver
        ? this.profileResolver.getProfile(activeModelId)
        : {
            id: activeModelId,
            providerId: 'openai-compatible',
            providerModelName: activeModelId,
            provider: 'openai-compatible',
            model: activeModelId,
            trustLevel: 'standard' as const,
            reliabilityClass: 'standard' as const,
            contextWindow: 128000,
            capabilities: {
              toolCalling: true,
              structuredOutput: true,
              vision: false,
              longContext: true,
              codeExecutionPlanning: true,
            },
            reliability: {
              structuredOutput: 0.9,
              toolArguments: 0.9,
              longHorizonPlanning: 0.8,
              summarization: 0.9,
              instructionFollowing: 0.9,
            },
            economics: {},
            allowedRoles: [req.role],
            limits: {
              maxVisibleTools: 20,
              maxIterations: 50,
              maxRepairAttempts: 1,
              maxConsecutiveFailures: 2,
            },
            fallbackModelIds: [],
          }

      const roleCheck = ModelRolePolicy.validateRolePermission(
        modelProfile,
        req.role,
        'stream_agent_turn',
      )
      if (!roleCheck.allowed) {
        // Record role_denied, not schema failure
        this.healthStore.recordFailure(
          activeModelId,
          'role',
          `role_denied: ${roleCheck.reason}`,
          req.taskId,
        )
        continue
      }

      try {
        const providerId = modelProfile.providerId || modelProfile.provider
        let provider = this.providers.get(providerId)
        if (!provider && this.providers.size > 0) {
          provider =
            Array.from(this.providers.values()).find(
              (p) => p.id.includes(providerId) || providerId.includes(p.id),
            ) || Array.from(this.providers.values())[0]
        }
        if (!provider) {
          throw new MissingModelProviderError(activeModelId, providerId)
        }

        const rawStream = await provider.streamAgentTurn(modelProfile, {
          taskId: req.taskId,
          agentRunId: req.agentRunId,
          role: req.role,
          preferredModelId: activeModelId,
          messages: req.messages,
          tools: req.tools,
          temperature: req.temperature,
          maxOutputTokens: req.maxOutputTokens,
          signal: req.signal,
        })

        return new MonitoredAgentTurnStream(
          rawStream,
          activeModelId,
          req.taskId,
          this.healthStore,
          this.circuitBreaker,
        )
      } catch (err: any) {
        this.healthStore.recordFailure(activeModelId, 'provider', err.message, req.taskId)
        lastError = err
      }
    }

    throw (
      lastError ||
      new Error(
        `ModelInvocationGateway failed streamAgentTurn for role '${req.role}' across candidate models [${candidateModels.join(', ')}].`,
      )
    )
  }

  public async executeStructured<T>(
    req: StructuredModelRequest<T>,
  ): Promise<StructuredModelResponse<T>> {
    const startTime = Date.now()

    const routingDecision = this.router.route({
      role: req.role,
      preferredModelId: req.preferredModelId,
      taskId: req.taskId,
      hasProvider: (pId) => {
        if (this.providers.size === 0) return true
        return (
          this.providers.has(pId) ||
          Array.from(this.providers.values()).some((p) => p.id.includes(pId) || pId.includes(p.id))
        )
      },
    })

    this.trajectoryRecorder?.record(
      req.taskId,
      'model_routing_decision',
      {
        selectedModelId: routingDecision.selectedModelId,
        reason: routingDecision.reason,
        role: req.role,
        mode: 'structured',
      },
      this.getRevision(req.taskId),
      req.agentRunId,
    )

    const candidateModels = [routingDecision.selectedModelId, ...routingDecision.fallbackModelIds]

    let lastError: Error | null = null
    const maxChars = req.maxRepairRawChars ?? 4000

    for (let i = 0; i < candidateModels.length; i++) {
      const activeModelId = candidateModels[i]
      const isFallback = i > 0

      const modelProfile = this.profileResolver
        ? this.profileResolver.getProfile(activeModelId)
        : {
            id: activeModelId,
            providerId: 'openai-compatible',
            providerModelName: activeModelId,
            provider: 'openai-compatible',
            model: activeModelId,
            trustLevel: 'standard' as const,
            reliabilityClass: 'standard' as const,
            contextWindow: 128000,
            capabilities: {
              toolCalling: true,
              structuredOutput: true,
              vision: false,
              longContext: true,
              codeExecutionPlanning: true,
            },
            reliability: {
              structuredOutput: 0.9,
              toolArguments: 0.9,
              longHorizonPlanning: 0.8,
              summarization: 0.9,
              instructionFollowing: 0.9,
            },
            economics: {},
            allowedRoles: [req.role],
            limits: {
              maxVisibleTools: 20,
              maxIterations: 50,
              maxRepairAttempts: 1,
              maxConsecutiveFailures: 2,
            },
            fallbackModelIds: [],
          }

      const roleCheck = ModelRolePolicy.validateRolePermission(
        modelProfile,
        req.role,
        'structured_query',
      )
      if (!roleCheck.allowed) {
        this.healthStore.recordFailure(
          activeModelId,
          'role',
          `role_denied: ${roleCheck.reason}`,
          req.taskId,
        )
        continue
      }

      try {
        let executor = req.llmExecutor
        if (!executor) {
          const providerId = modelProfile.providerId || modelProfile.provider
          let provider = this.providers.get(providerId)
          if (!provider && this.providers.size > 0) {
            provider =
              Array.from(this.providers.values()).find(
                (p) => p.id.includes(providerId) || providerId.includes(p.id),
              ) || Array.from(this.providers.values())[0]
          }
          if (!provider) {
            throw new MissingModelProviderError(activeModelId, providerId)
          }
          executor = async (mId, sys, user) => {
            const res = await provider.executeStructured(modelProfile, {
              taskId: req.taskId,
              agentRunId: req.agentRunId,
              role: req.role,
              preferredModelId: mId,
              systemPrompt: sys,
              userPrompt: user,
              signal: req.signal,
            })
            return {
              rawText: res.rawText,
              usage: res.usage
                ? { inputTokens: res.usage.promptTokens, outputTokens: res.usage.completionTokens }
                : undefined,
            }
          }
        }

        const res = await executor(activeModelId, req.systemPrompt, req.userPrompt)

        if (res.rawText === '' || res.rawText === undefined) {
          this.healthStore.recordFailure(activeModelId, 'empty', 'empty_response', req.taskId)
          continue
        }

        let parsedResult: T | null = null
        let repaired = false

        try {
          const parsedJson = JSON.parse(res.rawText)
          parsedResult = req.outputSchema.parse(parsedJson)
        } catch (parseErr: any) {
          this.healthStore.recordFailure(
            activeModelId,
            'schema',
            `Schema parse failed: ${parseErr.message}`,
            req.taskId,
          )

          const rec = this.healthStore.getRecord(activeModelId, req.taskId)
          if (this.circuitBreaker.shouldTripCircuit(rec)) {
            continue
          }

          const truncatedRaw = res.rawText.slice(0, maxChars)
          const repairPrompt = `Your previous JSON output failed validation with error: ${parseErr.message}. Output ONLY valid JSON matching the schema. Raw text was: ${truncatedRaw}`
          const repairRes = await executor(activeModelId, req.systemPrompt, repairPrompt)

          try {
            const repairedJson = JSON.parse(repairRes.rawText)
            parsedResult = req.outputSchema.parse(repairedJson)
            repaired = true
          } catch (repairErr: any) {
            this.healthStore.recordFailure(
              activeModelId,
              'schema',
              `Repair failed: ${repairErr.message}`,
              req.taskId,
            )
            this.circuitBreaker.shouldTripCircuit(
              this.healthStore.getRecord(activeModelId, req.taskId),
            )
            lastError = new Error(
              `Model '${activeModelId}' failed output schema parsing twice: ${repairErr.message}`,
            )
            continue
          }
        }

        if (parsedResult !== null) {
          this.healthStore.recordSuccess(activeModelId, req.taskId)
          return {
            modelId: activeModelId,
            value: parsedResult,
            repaired,
            fallbackUsed: isFallback,
            usage: res.usage,
            durationMs: Date.now() - startTime,
            routingDecision,
          }
        }
      } catch (err: any) {
        this.healthStore.recordFailure(activeModelId, 'provider', err.message, req.taskId)
        lastError = err
      }
    }

    throw (
      lastError ||
      new Error(
        `StructuredModelGateway failed for role '${req.role}' across candidate models [${candidateModels.join(', ')}].`,
      )
    )
  }
}
