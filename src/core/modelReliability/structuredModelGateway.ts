import { z } from 'zod'
import type OpenAI from 'openai'

import { ModelRole } from './modelCapability.js'
import { ModelCircuitBreaker } from './modelCircuitBreaker.js'
import { ModelHealthStore } from './modelHealth.js'
import { ModelRolePolicy } from './modelRolePolicy.js'
import { ModelRouter, ModelRoutingDecision } from './modelRouter.js'
import { ModelProvider } from './providers/modelProvider.js'
import { MissingModelProviderError } from './errors.js'
import { TrajectoryRecorder } from '../trajectory/trajectoryRecorder.js'

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

  executeStructured<T>(
    input: StructuredModelRequest<T>,
  ): Promise<StructuredModelResponse<T>>
}

export class StructuredModelGateway implements ModelInvocationGateway {
  private router: ModelRouter
  private healthStore: ModelHealthStore
  private circuitBreaker: ModelCircuitBreaker
  private trajectoryRecorder?: TrajectoryRecorder
  private providers = new Map<string, ModelProvider>()

  constructor(
    router: ModelRouter,
    healthStore: ModelHealthStore,
    circuitBreaker: ModelCircuitBreaker,
    trajectoryRecorder?: TrajectoryRecorder,
  ) {
    this.router = router
    this.healthStore = healthStore
    this.circuitBreaker = circuitBreaker
    this.trajectoryRecorder = trajectoryRecorder
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

  public async streamAgentTurn(
    req: AgentTurnModelRequest,
  ): Promise<AsyncIterable<OpenAI.Chat.ChatCompletionChunk>> {
    const routingDecision = this.router.route({
      role: req.role,
      preferredModelId: req.preferredModelId,
      requiredCapabilities: req.requiredCapabilities,
      taskId: req.taskId,
      hasProvider: (pId) => this.providers.size > 0 ? this.providers.has(pId) : true,
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
      1,
      req.agentRunId,
    )

    const candidateModels = [
      routingDecision.selectedModelId,
      ...routingDecision.fallbackModelIds,
    ]

    let lastError: Error | null = null

    for (let i = 0; i < candidateModels.length; i++) {
      const activeModelId = candidateModels[i]

      const roleCheck = ModelRolePolicy.validateRolePermission(
        activeModelId,
        req.role,
        'stream_agent_turn',
      )
      if (!roleCheck.allowed) {
        this.healthStore.recordFailure(activeModelId, 'schema', roleCheck.reason, req.taskId)
        continue
      }

      try {
        let provider = Array.from(this.providers.values())[0]
        if (!provider) {
          throw new MissingModelProviderError(activeModelId, 'openai-compatible')
        }

        const modelProfile = {
          id: activeModelId,
          provider: provider.id,
          model: activeModelId,
          contextWindow: 128000,
          capabilities: { toolCalling: true, structuredOutput: true, vision: false, longContext: true, codeExecutionPlanning: true },
          reliability: { structuredOutput: 0.9, toolArguments: 0.9, longHorizonPlanning: 0.8, summarization: 0.9, instructionFollowing: 0.9 },
          economics: {},
          allowedRoles: [req.role],
          limits: { maxVisibleTools: 20, maxIterations: 50, maxRepairAttempts: 1, maxConsecutiveFailures: 2 },
          fallbackModelIds: [],
        }

        const stream = await provider.streamAgentTurn(modelProfile, {
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

        this.healthStore.recordSuccess(activeModelId, req.taskId)
        return stream
      } catch (err: any) {
        this.healthStore.recordFailure(
          activeModelId,
          'provider',
          err.message,
          req.taskId,
        )
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
      hasProvider: (pId) => this.providers.size > 0 ? this.providers.has(pId) : true,
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
      1,
      req.agentRunId,
    )

    const candidateModels = [
      routingDecision.selectedModelId,
      ...routingDecision.fallbackModelIds,
    ]

    let lastError: Error | null = null
    const maxChars = req.maxRepairRawChars ?? 4000

    for (let i = 0; i < candidateModels.length; i++) {
      const activeModelId = candidateModels[i]
      const isFallback = i > 0

      const roleCheck = ModelRolePolicy.validateRolePermission(
        activeModelId,
        req.role,
        'structured_query',
      )
      if (!roleCheck.allowed) {
        this.healthStore.recordFailure(activeModelId, 'schema', roleCheck.reason, req.taskId)
        continue
      }

      try {
        let executor = req.llmExecutor
        if (!executor) {
          const provider = Array.from(this.providers.values())[0]
          if (!provider) {
            throw new MissingModelProviderError(activeModelId, 'default')
          }
          executor = async (mId, sys, user) => {
            const modelProfile = {
              id: mId,
              provider: provider.id,
              model: mId,
              contextWindow: 128000,
              capabilities: { toolCalling: true, structuredOutput: true, vision: false, longContext: true, codeExecutionPlanning: true },
              reliability: { structuredOutput: 0.9, toolArguments: 0.9, longHorizonPlanning: 0.8, summarization: 0.9, instructionFollowing: 0.9 },
              economics: {},
              allowedRoles: [req.role],
              limits: { maxVisibleTools: 20, maxIterations: 50, maxRepairAttempts: 1, maxConsecutiveFailures: 2 },
              fallbackModelIds: [],
            }
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
          const repairRes = await executor(
            activeModelId,
            req.systemPrompt,
            repairPrompt,
          )

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
        this.healthStore.recordFailure(
          activeModelId,
          'provider',
          err.message,
          req.taskId,
        )
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
