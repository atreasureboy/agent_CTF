import { z } from 'zod'

export type ModelRole =
  | 'competition_coordinator'
  | 'task_planner'
  | 'solver_scout'
  | 'deep_solver'
  | 'context_compiler'
  | 'progress_summarizer'
  | 'specialist'
  | 'flag_discriminator'
  | 'reporter'

export type ModelTrustLevel = 'auxiliary' | 'standard' | 'privileged'

export const ModelCapabilityProfileSchema = z.object({
  id: z.string(),
  providerId: z.string().default('openai-compatible'),
  providerModelName: z.string().default('gpt-4o'),
  provider: z.string().default('openai-compatible'),
  model: z.string().default('gpt-4o'),
  trustLevel: z.enum(['auxiliary', 'standard', 'privileged']).default('standard'),
  reliabilityClass: z.enum(['auxiliary', 'standard', 'privileged']).default('standard'),

  contextWindow: z.number().positive(),

  capabilities: z.object({
    toolCalling: z.boolean(),
    structuredOutput: z.boolean(),
    vision: z.boolean(),
    longContext: z.boolean(),
    codeExecutionPlanning: z.boolean(),
  }),

  reliability: z.object({
    structuredOutput: z.number().min(0).max(1),
    toolArguments: z.number().min(0).max(1),
    longHorizonPlanning: z.number().min(0).max(1),
    summarization: z.number().min(0).max(1),
    instructionFollowing: z.number().min(0).max(1),
  }),

  economics: z.object({
    inputCostPerMillion: z.number().optional(),
    outputCostPerMillion: z.number().optional(),
    expectedLatencyMs: z.number().optional(),
  }),

  allowedRoles: z.array(
    z.enum([
      'competition_coordinator',
      'task_planner',
      'solver_scout',
      'deep_solver',
      'context_compiler',
      'progress_summarizer',
      'specialist',
      'flag_discriminator',
      'reporter',
    ]),
  ),

  limits: z.object({
    maxVisibleTools: z.number().positive(),
    maxIterations: z.number().positive(),
    maxRepairAttempts: z.number().positive(),
    maxConsecutiveFailures: z.number().positive(),
  }),

  fallbackModelIds: z.array(z.string()),
})

export type ModelCapabilityProfile = z.infer<typeof ModelCapabilityProfileSchema>

/**
 * Conservative baseline profile for any unrecognized or default models
 */
export const DEFAULT_CONSERVATIVE_PROFILE: ModelCapabilityProfile = {
  id: 'default-conservative',
  providerId: 'unknown',
  providerModelName: 'default',
  provider: 'unknown',
  model: 'default',
  trustLevel: 'auxiliary',
  reliabilityClass: 'auxiliary',
  contextWindow: 16384,
  capabilities: {
    toolCalling: true,
    structuredOutput: true,
    vision: false,
    longContext: false,
    codeExecutionPlanning: false,
  },
  reliability: {
    structuredOutput: 0.7,
    toolArguments: 0.7,
    longHorizonPlanning: 0.5,
    summarization: 0.7,
    instructionFollowing: 0.7,
  },
  economics: {
    expectedLatencyMs: 2000,
  },
  allowedRoles: [
    'competition_coordinator',
    'task_planner',
    'solver_scout',
    'deep_solver',
    'progress_summarizer',
    'context_compiler',
    'specialist',
    'flag_discriminator',
    'reporter',
  ],
  limits: {
    maxVisibleTools: 12,
    maxIterations: 10,
    maxRepairAttempts: 1,
    maxConsecutiveFailures: 2,
  },
  fallbackModelIds: [],
}
