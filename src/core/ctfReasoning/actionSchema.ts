/**
 * StructuredOutput / ActionSchema — Phase borrow-plan Phase F.
 *
 * Inspired by CAI's `AgentOutputSchema` and swe-agent's `JsonParser`:
 * before invoking the executor, validate the LLM's emitted
 * `SuggestedAction` against the type's typed schema. If invalid,
 * surface a structured error so the LLM can self-correct.
 *
 * We hand-roll the schema (no Zod dependency) — each branch returns
 * either a typed value or a list of validation errors.
 */

import type { SuggestedAction } from './suggestedAction.js'

export interface ValidationError {
  path: string
  message: string
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: ValidationError[] }

/** A run_workflow action with all required fields. */
export interface RunWorkflowAction {
  type: 'run_workflow'
  workflowId: string
  inputs: Record<string, unknown>
  reason: string
  priority: number
  costTier: 'cheap' | 'normal' | 'expensive'
  hypothesisIds?: string[]
}

export interface RunOneShotAction {
  type: 'run_oneshot'
  manifestId: string
  inputArtifactIds: string[]
  options?: Record<string, unknown>
  reason: string
  priority: number
  costTier: 'cheap' | 'normal' | 'expensive'
  hypothesisIds?: string[]
}

export interface CallToolAction {
  type: 'call_tool'
  toolId: string
  input: Record<string, unknown>
  reason: string
  priority: number
  costTier: 'cheap' | 'normal' | 'expensive'
  hypothesisIds?: string[]
}

export interface RequestHandoffAction {
  type: 'request_handoff'
  capability: string
  objective: string
  artifactIds: string[]
  evidenceIds?: string[]
  findingIds?: string[]
  reason: string
  priority: number
  costTier: 'cheap' | 'normal' | 'expensive'
  hypothesisIds?: string[]
}

export interface VerifyFlagAction {
  type: 'verify_flag'
  candidateId: string
  reason: string
  priority: number
  costTier: 'cheap' | 'normal' | 'expensive'
  hypothesisIds?: string[]
}

export interface StopAction {
  type: 'stop'
  reason: string
  priority: number
  costTier: 'cheap' | 'normal' | 'expensive'
  hypothesisIds?: string[]
}

export type StructuredAction =
  | RunWorkflowAction
  | RunOneShotAction
  | CallToolAction
  | RequestHandoffAction
  | VerifyFlagAction
  | StopAction

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

function isString(v: unknown): v is string {
  return typeof v === 'string'
}

function isNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(isString)
}

function isCostTier(v: unknown): v is 'cheap' | 'normal' | 'expensive' {
  return v === 'cheap' || v === 'normal' || v === 'expensive'
}

function isPriority(v: unknown): v is number {
  return isNumber(v) && v >= 0 && v <= 100
}

/** Validate a JSON-ish object as a StructuredAction. The LLM is
 *  expected to emit JSON; we accept any object and walk it. */
export function validateAction(raw: unknown): ValidationResult<StructuredAction> {
  if (!isObject(raw)) {
    return { ok: false, errors: [{ path: '$', message: 'expected object' }] }
  }
  const t = raw['type']
  if (!isString(t)) {
    return { ok: false, errors: [{ path: '$.type', message: 'expected string' }] }
  }
  switch (t) {
    case 'run_workflow':
      return validateRunWorkflow(raw)
    case 'run_oneshot':
      return validateRunOneshot(raw)
    case 'call_tool':
      return validateCallTool(raw)
    case 'request_handoff':
      return validateRequestHandoff(raw)
    case 'verify_flag':
      return validateVerifyFlag(raw)
    case 'stop':
      return validateStop(raw)
    default:
      return { ok: false, errors: [{ path: '$.type', message: `unknown action type: ${t}` }] }
  }
}

function validateRunWorkflow(raw: Record<string, unknown>): ValidationResult<RunWorkflowAction> {
  const errors: ValidationError[] = []
  if (!isNonEmptyString(raw['workflowId']))
    errors.push({ path: '$.workflowId', message: 'expected non-empty string' })
  if (!isObject(raw['inputs'])) errors.push({ path: '$.inputs', message: 'expected object' })
  if (!isNonEmptyString(raw['reason']))
    errors.push({ path: '$.reason', message: 'expected non-empty string' })
  if (!isPriority(raw['priority'])) errors.push({ path: '$.priority', message: 'expected 0..100' })
  if (!isCostTier(raw['costTier']))
    errors.push({ path: '$.costTier', message: 'expected cheap|normal|expensive' })
  if (errors.length > 0) return { ok: false, errors }
  return {
    ok: true,
    value: {
      type: 'run_workflow',
      workflowId: raw['workflowId'] as string,
      inputs: raw['inputs'] as Record<string, unknown>,
      reason: raw['reason'] as string,
      priority: raw['priority'] as number,
      costTier: raw['costTier'] as 'cheap' | 'normal' | 'expensive',
      ...(Array.isArray(raw['hypothesisIds'])
        ? { hypothesisIds: raw['hypothesisIds'] as string[] }
        : {}),
    },
  }
}

function validateRunOneshot(raw: Record<string, unknown>): ValidationResult<RunOneShotAction> {
  const errors: ValidationError[] = []
  if (!isNonEmptyString(raw['manifestId']))
    errors.push({ path: '$.manifestId', message: 'expected non-empty string' })
  if (!isStringArray(raw['inputArtifactIds']))
    errors.push({ path: '$.inputArtifactIds', message: 'expected string[]' })
  if (raw['options'] !== undefined && !isObject(raw['options']))
    errors.push({ path: '$.options', message: 'expected object' })
  if (!isNonEmptyString(raw['reason']))
    errors.push({ path: '$.reason', message: 'expected non-empty string' })
  if (!isPriority(raw['priority'])) errors.push({ path: '$.priority', message: 'expected 0..100' })
  if (!isCostTier(raw['costTier']))
    errors.push({ path: '$.costTier', message: 'expected cheap|normal|expensive' })
  if (errors.length > 0) return { ok: false, errors }
  return {
    ok: true,
    value: {
      type: 'run_oneshot',
      manifestId: raw['manifestId'] as string,
      inputArtifactIds: raw['inputArtifactIds'] as string[],
      ...(raw['options'] !== undefined
        ? { options: raw['options'] as Record<string, unknown> }
        : {}),
      reason: raw['reason'] as string,
      priority: raw['priority'] as number,
      costTier: raw['costTier'] as 'cheap' | 'normal' | 'expensive',
      ...(Array.isArray(raw['hypothesisIds'])
        ? { hypothesisIds: raw['hypothesisIds'] as string[] }
        : {}),
    },
  }
}

function validateCallTool(raw: Record<string, unknown>): ValidationResult<CallToolAction> {
  const errors: ValidationError[] = []
  if (!isNonEmptyString(raw['toolId']))
    errors.push({ path: '$.toolId', message: 'expected non-empty string' })
  if (!isObject(raw['input'])) errors.push({ path: '$.input', message: 'expected object' })
  if (!isNonEmptyString(raw['reason']))
    errors.push({ path: '$.reason', message: 'expected non-empty string' })
  if (!isPriority(raw['priority'])) errors.push({ path: '$.priority', message: 'expected 0..100' })
  if (!isCostTier(raw['costTier']))
    errors.push({ path: '$.costTier', message: 'expected cheap|normal|expensive' })
  if (errors.length > 0) return { ok: false, errors }
  return {
    ok: true,
    value: {
      type: 'call_tool',
      toolId: raw['toolId'] as string,
      input: raw['input'] as Record<string, unknown>,
      reason: raw['reason'] as string,
      priority: raw['priority'] as number,
      costTier: raw['costTier'] as 'cheap' | 'normal' | 'expensive',
      ...(Array.isArray(raw['hypothesisIds'])
        ? { hypothesisIds: raw['hypothesisIds'] as string[] }
        : {}),
    },
  }
}

function validateRequestHandoff(
  raw: Record<string, unknown>,
): ValidationResult<RequestHandoffAction> {
  const errors: ValidationError[] = []
  if (!isNonEmptyString(raw['capability']))
    errors.push({ path: '$.capability', message: 'expected non-empty string' })
  if (!isNonEmptyString(raw['objective']))
    errors.push({ path: '$.objective', message: 'expected non-empty string' })
  if (!isStringArray(raw['artifactIds']))
    errors.push({ path: '$.artifactIds', message: 'expected string[]' })
  if (!isNonEmptyString(raw['reason']))
    errors.push({ path: '$.reason', message: 'expected non-empty string' })
  if (!isPriority(raw['priority'])) errors.push({ path: '$.priority', message: 'expected 0..100' })
  if (!isCostTier(raw['costTier']))
    errors.push({ path: '$.costTier', message: 'expected cheap|normal|expensive' })
  if (errors.length > 0) return { ok: false, errors }
  return {
    ok: true,
    value: {
      type: 'request_handoff',
      capability: raw['capability'] as string,
      objective: raw['objective'] as string,
      artifactIds: raw['artifactIds'] as string[],
      ...(raw['evidenceIds'] !== undefined ? { evidenceIds: raw['evidenceIds'] as string[] } : {}),
      ...(raw['findingIds'] !== undefined ? { findingIds: raw['findingIds'] as string[] } : {}),
      reason: raw['reason'] as string,
      priority: raw['priority'] as number,
      costTier: raw['costTier'] as 'cheap' | 'normal' | 'expensive',
      ...(Array.isArray(raw['hypothesisIds'])
        ? { hypothesisIds: raw['hypothesisIds'] as string[] }
        : {}),
    },
  }
}

function validateVerifyFlag(raw: Record<string, unknown>): ValidationResult<VerifyFlagAction> {
  const errors: ValidationError[] = []
  if (!isNonEmptyString(raw['candidateId']))
    errors.push({ path: '$.candidateId', message: 'expected non-empty string' })
  if (!isNonEmptyString(raw['reason']))
    errors.push({ path: '$.reason', message: 'expected non-empty string' })
  if (!isPriority(raw['priority'])) errors.push({ path: '$.priority', message: 'expected 0..100' })
  if (!isCostTier(raw['costTier']))
    errors.push({ path: '$.costTier', message: 'expected cheap|normal|expensive' })
  if (errors.length > 0) return { ok: false, errors }
  return {
    ok: true,
    value: {
      type: 'verify_flag',
      candidateId: raw['candidateId'] as string,
      reason: raw['reason'] as string,
      priority: raw['priority'] as number,
      costTier: raw['costTier'] as 'cheap' | 'normal' | 'expensive',
      ...(Array.isArray(raw['hypothesisIds'])
        ? { hypothesisIds: raw['hypothesisIds'] as string[] }
        : {}),
    },
  }
}

function validateStop(raw: Record<string, unknown>): ValidationResult<StopAction> {
  const errors: ValidationError[] = []
  if (!isNonEmptyString(raw['reason']))
    errors.push({ path: '$.reason', message: 'expected non-empty string' })
  if (!isPriority(raw['priority'])) errors.push({ path: '$.priority', message: 'expected 0..100' })
  if (!isCostTier(raw['costTier']))
    errors.push({ path: '$.costTier', message: 'expected cheap|normal|expensive' })
  if (errors.length > 0) return { ok: false, errors }
  return {
    ok: true,
    value: {
      type: 'stop',
      reason: raw['reason'] as string,
      priority: raw['priority'] as number,
      costTier: raw['costTier'] as 'cheap' | 'normal' | 'expensive',
      ...(Array.isArray(raw['hypothesisIds'])
        ? { hypothesisIds: raw['hypothesisIds'] as string[] }
        : {}),
    },
  }
}

/** Convert a validation failure into a JSON string the LLM can
 *  inspect in its next turn. Format mirrors JSON-Schema validator
 *  output. */
export function formatValidationErrors(errors: ReadonlyArray<ValidationError>): string {
  if (errors.length === 0) return ''
  return errors.map((e) => `${e.path}: ${e.message}`).join('; ')
}
