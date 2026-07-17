/**
 * Agent config — declarative extension surface (.ovogo/agent.json).
 *
 * Why this exists: adding tools, modules, permission rules, the verify gate, or
 * the model context window previously required editing bin source. This file is
 * the single config-driven extension point — downstream consumers configure the
 * base without forking it.
 *
 * Resolution order (later wins, deep-merged):
 *   1. built-in defaults (this module)
 *   2. ~/.ovogo/agent.json   (user global)
 *   3. .ovogo/agent.json     (project)
 *   4. CLI flags / env       (applied by bin)
 *
 * Schema (all fields optional — omit = keep defaults):
 *   {
 *     "model": "gpt-4o",
 *     "maxIterations": 30,
 *     "maxContextTokens": 128000,
 *     "modules": ["memory", "critic", "workspace"],
 *     "permission": { "mode": "ask", "rules": [ { "tool": "Bash", "pattern": "rm -rf", "action": "ask" } ] },
 *     "mcpServers": {
 *       "time": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-everything"] }
 *     },
 *     "verifyCommands": ["npm run typecheck", "npm test"],
 *     "pricing": { "inputPer1M": 2.5, "outputPer1M": 10 }
 *   }
 *
 * mcpServers: each entry spawns a stdio MCP server; its tools are discovered at
 * startup and surfaced to the agent as `mcp__<server>__<tool>`.
 */

import { readFileSync, existsSync } from 'fs'
import { resolve, join } from 'path'
import { homedir } from 'os'
import type { PermissionMode, PermissionRule } from '../core/permission.js'

/** A stdio MCP server declaration. */
export interface McpServerConfig {
  command: string
  args?: string[]
  env?: Record<string, string>
  /** Optional working directory for the spawned server process. */
  cwd?: string
}

export interface PricingConfig {
  /** USD per 1M input (prompt) tokens. */
  inputPer1M?: number
  /** USD per 1M output (completion) tokens. */
  outputPer1M?: number
}

export interface AgentConfigFile {
  model?: string
  maxIterations?: number
  /** Context window for the selected model. Falls back to a model→tokens map. */
  maxContextTokens?: number
  modules?: string[]
  permission?: {
    mode?: PermissionMode
    rules?: PermissionRule[]
  }
  mcpServers?: Record<string, McpServerConfig>
  /** Commands run by the Agent verification gate (replaces hardcoded `tsc`). */
  verifyCommands?: string[]
  pricing?: PricingConfig
}

/** Known model → context window map, so consumers don't hardcode token counts. */
export const MODEL_CONTEXT_TOKENS: Record<string, number> = {
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
  'gpt-4.1': 1_000_000,
  'gpt-4.1-mini': 1_000_000,
  'o1': 200_000,
  'o3': 200_000,
  'o3-mini': 200_000,
  'claude-sonnet-4-x': 200_000,
  'claude-sonnet-4-5': 200_000,
  'claude-opus-4-x': 200_000,
  'deepseek-chat': 64_000,
  'deepseek-reasoner': 64_000,
}

/** Fallback when neither config nor the model map know the window. */
export const DEFAULT_CONTEXT_TOKENS = 128_000

/** Resolve the context window for a model from the map, else the default. */
export function contextTokensForModel(model: string, override?: number): number {
  if (typeof override === 'number') return override
  // Exact match first, then prefix match (handles dated variants like gpt-4o-2024-08-06)
  if (MODEL_CONTEXT_TOKENS[model]) return MODEL_CONTEXT_TOKENS[model]
  for (const key of Object.keys(MODEL_CONTEXT_TOKENS)) {
    if (model.startsWith(key)) return MODEL_CONTEXT_TOKENS[key]
  }
  return DEFAULT_CONTEXT_TOKENS
}

function tryParse(path: string): AgentConfigFile {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as AgentConfigFile
  } catch {
    return {}
  }
}

/** Deep-merge two config files (b wins). Arrays and objects replace by key. */
function mergeConfigs(a: AgentConfigFile, b: AgentConfigFile): AgentConfigFile {
  return {
    model: b.model ?? a.model,
    maxIterations: b.maxIterations ?? a.maxIterations,
    maxContextTokens: b.maxContextTokens ?? a.maxContextTokens,
    modules: b.modules ?? a.modules,
    permission: {
      mode: b.permission?.mode ?? a.permission?.mode,
      rules: [...(a.permission?.rules ?? []), ...(b.permission?.rules ?? [])],
    },
    mcpServers: { ...(a.mcpServers ?? {}), ...(b.mcpServers ?? {}) },
    verifyCommands: b.verifyCommands ?? a.verifyCommands,
    pricing: { ...a.pricing, ...b.pricing },
  }
}

/**
 * Load and merge agent config from global + project locations.
 * Returns {} if no config files exist (caller applies built-in defaults).
 */
export function loadAgentConfig(cwd: string): AgentConfigFile {
  const globalPath = join(homedir(), '.ovogo', 'agent.json')
  const projectPath = resolve(cwd, '.ovogo', 'agent.json')
  let cfg: AgentConfigFile = {}
  if (existsSync(globalPath)) cfg = mergeConfigs(cfg, tryParse(globalPath))
  if (existsSync(projectPath)) cfg = mergeConfigs(cfg, tryParse(projectPath))
  return cfg
}
