/**
 * AgentRuntimeDependencies — the shared runtime building blocks a CTF Task
 * hands to every harness it spawns (main + specialists).
 *
 * Per forth_goal.md §七:
 *   - Main Harness and Specialist Harness use the SAME group of deps.
 *   - Specialists MUST NOT re-construct an OpenAI client from env.
 *   - Specialists MUST NOT run without a Renderer.
 *   - Workflow-only mode is allowed without client/renderer.
 *   - LLM mode MUST validate client + renderer.
 *   - RuntimeDependencies MUST NOT save TaskState.
 *   - RuntimeDependencies MUST NOT save Profile.
 *
 * This module is the canonical interface. The factory / orchestrator use it
 * to wire the Broker / Renderer / Model / EventLog / Logger into every
 * child harness created via SpecialistHarnessFactory.
 */

import type OpenAI from 'openai'

import type { Renderer } from '../../ui/renderer.js'
import type { EventLog } from '../eventLog.js'
import type { Logger } from '../logger.js'

export interface ModelConfig {
  model: string
  apiKey: string
  baseURL?: string
}

export interface AgentRuntimeDependencies {
  /** OpenAI-compatible client. Required for LLM mode; optional for workflow-only. */
  client?: OpenAI
  /** Renderer for streaming output. Required for LLM mode; optional for workflow-only. */
  renderer?: Renderer
  /** Model configuration shared by main + every specialist. */
  modelConfig?: ModelConfig
  /** EventLog destination (optional). */
  eventLog?: EventLog
  /** Logger destination (optional). */
  logger?: Logger
}

/**
 * Validate that the runtime has everything an LLM-mode agent needs.
 * Throws with a human-readable message when something is missing.
 */
export function assertLlmDependencies(deps: AgentRuntimeDependencies): void {
  if (!deps.client) {
    throw new Error(
      'CTF Task: LLM mode requires an OpenAI client. ' +
        'Provide one via createCTFTaskRuntime({ client }) or env (OPENAI_API_KEY).',
    )
  }
  if (!deps.renderer) {
    throw new Error(
      'CTF Task: LLM mode requires a Renderer. ' +
        'Provide one via createCTFTaskRuntime({ renderer }).',
    )
  }
  if (!deps.modelConfig?.apiKey) {
    throw new Error(
      'CTF Task: LLM mode requires a modelConfig.apiKey. ' +
        'Provide one via createCTFTaskRuntime({ modelConfig }) or env (OPENAI_API_KEY).',
    )
  }
}