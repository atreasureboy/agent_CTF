/**
 * Workflow abstraction — a named, typed DAG of tool/shell/control steps.
 *
 * Why: the goal.md mandates "一把梭" (one-shot workflow) as a first-class
 * capability, not a series of bash strings. Workflows let us:
 *   - pre-check required tools and required binaries
 *   - parallelise independent steps
 *   - apply stop conditions early
 *   - emit structured Findings + Artifacts as the workflow runs
 *   - support sequential, parallel, conditional and DAG execution modes
 *
 * Steps are *descriptions*, not closures. The WorkflowEngine resolves them
 * against an injected runner (typically the ToolBroker). This keeps the
 * definitions declarative and trivially serialisable.
 */

import { z } from 'zod'

export type WorkflowStep =
  | {
      id: string
      kind: 'tool'
      toolId: string
      input?: Record<string, unknown>
      onFailure?: 'continue' | 'abort' | 'retry'
      timeoutMs?: number
      background?: boolean
      description?: string
    }
  | {
      id: string
      kind: 'shell'
      command: string
      onFailure?: 'continue' | 'abort' | 'retry'
      timeoutMs?: number
      background?: boolean
      description?: string
    }
  | {
      id: string
      kind: 'if'
      when: string
      then: WorkflowStep[]
      description?: string
    }
  | {
      id: string
      kind: 'parallel'
      steps: WorkflowStep[]
      join?: 'all' | 'any'
      description?: string
    }
  | {
      id: string
      kind: 'sequence'
      steps: WorkflowStep[]
      description?: string
    }
  | {
      id: string
      kind: 'emit_finding'
      category: string
      title: string
      summary: string
      confidence?: 'low' | 'medium' | 'high'
      artifactIds?: string[]
      suggestedNextActions?: string[]
      suggestedAgent?: string
    }

const stepBase = z
  .object({
    id: z.string(),
    onFailure: z.enum(['continue', 'abort', 'retry']).default('continue'),
    timeoutMs: z.number().int().positive().optional(),
    description: z.string().optional(),
  })
  .strict()

export const workflowStepSchema: z.ZodType<WorkflowStep> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    stepBase.extend({
      kind: z.literal('tool'),
      toolId: z.string(),
      input: z.record(z.unknown()).default({}),
      background: z.boolean().default(false),
    }),
    stepBase.extend({
      kind: z.literal('shell'),
      command: z.string(),
      background: z.boolean().default(false),
    }),
    z.object({
      id: z.string(),
      kind: z.literal('if'),
      when: z.string(),
      then: z.array(workflowStepSchema),
      description: z.string().optional(),
    }),
    z.object({
      id: z.string(),
      kind: z.literal('parallel'),
      steps: z.array(workflowStepSchema),
      join: z.enum(['all', 'any']).default('all'),
      description: z.string().optional(),
    }),
    z.object({
      id: z.string(),
      kind: z.literal('sequence'),
      steps: z.array(workflowStepSchema),
      description: z.string().optional(),
    }),
    z.object({
      id: z.string(),
      kind: z.literal('emit_finding'),
      category: z.string(),
      title: z.string(),
      summary: z.string(),
      confidence: z.enum(['low', 'medium', 'high']).default('medium'),
      artifactIds: z.array(z.string()).default([]),
      suggestedNextActions: z.array(z.string()).optional(),
      suggestedAgent: z.string().optional(),
    }),
  ]),
)

export const workflowDefinitionSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().default(''),
    domains: z.array(z.string()).default([]),
    acceptedInputs: z.array(z.string()).default([]),
    outputSchema: z.unknown().optional(),
    steps: z.array(workflowStepSchema).min(1),
    executionMode: z.enum(['sequential', 'parallel', 'dag']).default('sequential'),
    requiredTools: z.array(z.string()).default([]),
    /** Abort criteria — descriptive, the engine treats as opaque signals. */
    stopConditions: z.array(z.string()).default([]),
    partialFailurePolicy: z.enum(['continue', 'abort']).default('continue'),
  })
  .strict()

export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>

/* ─── Phase 2.1 §十八 / §二十二 — typed WorkflowDefinition ──────────── */

/** Phase 2.1 typed WorkflowDefinition. The new shape replaces the
 *  legacy `when: string` / `stopConditions: string[]` with structured
 *  predicates (`WorkflowCondition`) and an explicit DAG `dependsOn`
 *  field. Legacy workflows keep using `WorkflowDefinition` until they
 *  are migrated. */
import type { WorkflowCondition } from './ctfReasoning/workflowCondition.js'

export type TypedWorkflowStep =
  | {
      id: string
      kind: 'tool'
      toolId: string
      inputs?: Record<string, unknown>
      dependsOn?: string[]
      emit_finding?: false
      description?: string
      retry?: import('./typedDagExecutor.js').RetryConfig
    }
  | {
      id: string
      kind: 'request_handoff'
      capability: string
      dependsOn?: string[]
      emit_finding?: false
      description?: string
    }
  | {
      id: string
      kind: 'if'
      condition: WorkflowCondition
      then: TypedWorkflowStep[]
      else?: TypedWorkflowStep[]
      dependsOn?: string[]
      description?: string
    }
  | {
      id: string
      kind: 'emit_finding'
      dependsOn?: string[]
      fromEvidence?: {
        kinds?: string[]
        minConfidence?: number
        polarity?: 'supports' | 'contradicts' | 'neutral'
      }
      fromObservations?: { kinds?: string[]; minConfidence?: number }
      includeSuggestedActions?: boolean
      description?: string
    }

export interface TypedWorkflowDefinition {
  id: string
  displayName: string
  description: string
  /** When `true`, the workflow uses the legacy engine. Migrated
   *  workflows must be `false` (or omit). */
  legacy?: false
  executionMode: 'sequential' | 'parallel' | 'dag'
  inputs: string[]
  stopConditions: WorkflowCondition[]
  steps: TypedWorkflowStep[]
}

export type WorkflowRunStatus = 'success' | 'partial' | 'failed' | 'cancelled'

export interface StepOutcome {
  stepId: string
  status: 'success' | 'failed' | 'skipped'
  durationMs: number
  output?: string
  error?: string
  artifactIds?: string[]
  /** When the engine returns from a child step that wants to send a HandoffRequest. */
  handoffRequest?: { suggestedAgent: string; reason: string; objective: string }
}

export interface WorkflowRunResult {
  workflowId: string
  status: WorkflowRunStatus
  startedAt: string
  endedAt: string
  stepOutcomes: StepOutcome[]
  emittedFindingCount: number
  emittedArtifactCount: number
}

export function parseWorkflowDefinition(raw: unknown): WorkflowDefinition {
  return workflowDefinitionSchema.parse(raw)
}

export function safeParseWorkflowDefinition(raw: unknown): WorkflowDefinition | null {
  const r = workflowDefinitionSchema.safeParse(raw)
  return r.success ? r.data : null
}
