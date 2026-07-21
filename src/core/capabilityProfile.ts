/**
 * CapabilityProfile — describes what an agent is allowed to see and do.
 *
 * This is a single source of truth for agent-level permissions. Compared with
 * the legacy AgentConfig (preset + modules + tools + maxIterations), the Profile
 * adds explicit allow/deny lists for tools, workflows, and shell commands,
 * plus capability toggles (background jobs, sub-agent handoff, etc).
 *
 * Profiles are validated against capabilityProfileSchema at agent boot time —
 * configuration errors fail fast, never silently propagate.
 */

import { z } from 'zod'

const limitsSchema = z
  .object({
    maxIterations: z.number().int().positive().optional(),
    maxParallelJobs: z.number().int().nonnegative().optional(),
    maxExecutionSeconds: z.number().int().positive().optional(),
    maxToolCalls: z.number().int().positive().optional(),
  })
  .strict()
  .optional()

export const capabilityProfileSchema = z
  .object({
    id: z.string().min(1),
    displayName: z.string().min(1),
    description: z.string().optional(),
    systemPromptModules: z.array(z.string().min(1)).default([]),
    allowedTools: z.array(z.string()).optional(),
    deniedTools: z.array(z.string()).optional(),
    allowedWorkflows: z.array(z.string()).optional(),
    deniedWorkflows: z.array(z.string()).optional(),
    allowedCommands: z.array(z.string()).optional(),
    deniedCommands: z.array(z.string()).optional(),
    allowShell: z.boolean().default(false),
    allowPython: z.boolean().default(false),
    allowBackgroundJobs: z.boolean().default(true),
    allowAgentHandoff: z.boolean().default(true),
    preferredAgentsForHandoff: z.array(z.string()).optional(),
    limits: limitsSchema,
  })
  .strict()
  .superRefine((profile, ctx) => {
    // Tool overlap is intentionally permitted — denied wins, deny-list takes
    // precedence over allow-list at runtime. Schema-level enforcement would
    // actually weaken the deny precedence semantic.
    if (profile.allowedWorkflows && profile.deniedWorkflows) {
      const overlap = profile.allowedWorkflows.filter((w) =>
        profile.deniedWorkflows!.includes(w),
      )
      if (overlap.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Workflows declared both allowed and denied: ${overlap.join(', ')}`,
          path: ['deniedWorkflows'],
        })
      }
    }
    if (profile.allowedCommands && profile.deniedCommands) {
      const overlap = profile.allowedCommands.filter((c) =>
        profile.deniedCommands!.includes(c),
      )
      if (overlap.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Commands declared both allowed and denied: ${overlap.join(', ')}`,
          path: ['deniedCommands'],
        })
      }
    }
  })

export type CapabilityProfileInput = z.input<typeof capabilityProfileSchema>
export type CapabilityProfile = z.output<typeof capabilityProfileSchema>

/** Throws ZodError on invalid input — fail fast at boot. */
export function parseCapabilityProfile(raw: unknown): CapabilityProfile {
  return capabilityProfileSchema.parse(raw)
}

/** Returns null on invalid input — used by tools that accept optional config. */
export function safeParseCapabilityProfile(raw: unknown): CapabilityProfile | null {
  const r = capabilityProfileSchema.safeParse(raw)
  return r.success ? r.data : null
}

/**
 * Decide whether a tool id is permitted by this profile.
 * Rule order:
 *   1. Explicit deny wins (denyList takes precedence)
 *   2. AllowList, when present, restricts to that set
 *   3. Otherwise (no allowList) → permitted
 */
export function profileAllowsTool(profile: CapabilityProfile, toolId: string): boolean {
  if (profile.deniedTools?.includes(toolId)) return false
  if (profile.allowedTools && !profile.allowedTools.includes(toolId)) return false
  return true
}

/** Same logic, applied to workflow ids. */
export function profileAllowsWorkflow(
  profile: CapabilityProfile,
  workflowId: string,
): boolean {
  if (profile.deniedWorkflows?.includes(workflowId)) return false
  if (profile.allowedWorkflows && !profile.allowedWorkflows.includes(workflowId)) return false
  return true
}

/** Return the denyAllows / reason pair for a refused tool, so the Broker can
 * surface a structured message to the model. */
export function profileToolDenialReason(
  profile: CapabilityProfile,
  toolId: string,
): string | null {
  if (profile.deniedTools?.includes(toolId)) {
    return `Tool "${toolId}" is denied by profile "${profile.id}" (deniedTools).`
  }
  if (profile.allowedTools && !profile.allowedTools.includes(toolId)) {
    return `Tool "${toolId}" is not in profile "${profile.id}" allowedTools.`
  }
  return null
}
