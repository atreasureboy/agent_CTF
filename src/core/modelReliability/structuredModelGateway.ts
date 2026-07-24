import { z } from 'zod'

import { ModelRole } from './modelCapability.js'
import { ModelCircuitBreaker } from './modelCircuitBreaker.js'

import { ModelHealthStore } from './modelHealth.js'
import { ModelRolePolicy } from './modelRolePolicy.js'
import { ModelRouter, ModelRoutingDecision } from './modelRouter.js'

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
  // Mock LLM executor for isolated testing & pluggable provider backends
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

export class StructuredModelGateway {
  private router: ModelRouter
  private healthStore: ModelHealthStore
  private circuitBreaker: ModelCircuitBreaker

  constructor(
    router: ModelRouter,
    healthStore: ModelHealthStore,
    circuitBreaker: ModelCircuitBreaker,
  ) {
    this.router = router
    this.healthStore = healthStore
    this.circuitBreaker = circuitBreaker
  }

  public async executeStructured<T>(
    req: StructuredModelRequest<T>,
  ): Promise<StructuredModelResponse<T>> {
    const startTime = Date.now()

    // 1. Route model
    const routingDecision = this.router.route({
      role: req.role,
      preferredModelId: req.preferredModelId,
      taskId: req.taskId,
    })

    const candidateModels = [
      routingDecision.selectedModelId,
      ...routingDecision.fallbackModelIds,
    ]

    let lastError: Error | null = null

    for (let i = 0; i < candidateModels.length; i++) {
      const activeModelId = candidateModels[i]
      const isFallback = i > 0

      // Check role policy for active model
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
        const executor =
          req.llmExecutor ||
          (async (mId, sys, user) => {
            // Default placeholder executor if not provided
            return {
              rawText: JSON.stringify({ mockSuccess: true }),
              usage: { inputTokens: 100, outputTokens: 50 },
            }
          })

        // Initial call
        const res = await executor(activeModelId, req.systemPrompt, req.userPrompt)
        let parsedResult: T | null = null
        let repaired = false

        try {
          const parsedJson = JSON.parse(res.rawText)
          parsedResult = req.outputSchema.parse(parsedJson)
        } catch (parseErr: any) {
          // Schema failure — attempt ONE controlled repair prompt
          this.healthStore.recordFailure(
            activeModelId,
            'schema',
            `Schema parse failed: ${parseErr.message}`,
            req.taskId,
          )

          const rec = this.healthStore.getRecord(activeModelId, req.taskId)
          if (this.circuitBreaker.shouldTripCircuit(rec)) {
            // Circuit open, jump to fallback
            continue
          }

          // Single controlled repair attempt
          const repairPrompt = `Your previous JSON output failed validation with error: ${parseErr.message}. Output ONLY valid JSON conforming to the requested schema. Raw text was: ${res.rawText}`
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
            // Repair failed — record schema failure again & skip to fallback
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
          // Successful parse
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

    // Absolutely NO NOOP return on failure! Throw explicit exception
    throw (
      lastError ||
      new Error(
        `StructuredModelGateway failed for role '${req.role}' across all candidate models [${candidateModels.join(', ')}].`,
      )
    )
  }
}
