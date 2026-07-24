/**
 * CTF-aware Tool Definition — extends the base OpenAI-shaped ToolDefinition with
 * the metadata the CTF Harness needs to route, gate, and govern tool calls.
 *
 * Fields:
 *   - id                  Stable identifier (same as the LLM-exposed tool name)
 *   - name                Human-readable name
 *   - description         LLM-facing description
 *   - domains             Domain tags (for ToolFirstPolicy + capability checks)
 *                         e.g. ['forensics', 'image'], ['crypto'], ['web']
 *   - parameters          LLM-visible JSON Schema for arguments
 *   - executionMode       'foreground' | 'background' | 'either'
 *                         Background-capable tools can be spawned via JobManager
 *   - costClass           'cheap' | 'medium' | 'expensive'
 *                         Used by ToolFirstPolicy and budget enforcement
 *   - outputMode          'inline'    — return full content to the model
 *                         'artifact'  — long outputs persisted to disk + summary
 *                         'structured' — typed JSON result
 *   - riskLevel           'low' | 'medium' | 'high' — additional gating weight
 *   - requiredBinaries    Optional availability check; Broker will report
 *                         "unavailable" if any binary is missing on $PATH
 *
 * Existing Tool classes from src/tools/* remain unchanged on the wire — this
 * metadata is declared alongside via the ToolRegistry and not via class
 * modification, keeping the legacy interface contract intact.
 */

export type ToolDomain =
  | 'fs'
  | 'shell'
  | 'web'
  | 'image'
  | 'crypto'
  | 'forensics'
  | 'network'
  | 'reverse'
  | 'pwn'
  | 'memory'
  | 'workflow'
  | 'agent'
  | 'meta'

export type ToolExecutionMode = 'foreground' | 'background' | 'either'
export type ToolCostClass = 'cheap' | 'medium' | 'expensive'
export type ToolOutputMode = 'inline' | 'artifact' | 'structured'
export type ToolRiskLevel = 'low' | 'medium' | 'high'

export interface CTFToolMetadata {
  /** Domain tags for capability routing and ToolFirstPolicy. */
  domains: ToolDomain[]
  /** Whether the tool can be spawned as a background job. */
  executionMode: ToolExecutionMode
  /** Cost hint for budget + ToolFirstPolicy. */
  costClass: ToolCostClass
  /** Output mode: inline (LLM) | artifact (file) | structured (typed JSON). */
  outputMode: ToolOutputMode
  /** Optional risk level for additional gating (default 'low'). */
  riskLevel?: ToolRiskLevel
  /** Required binaries on PATH for this tool to function. */
  requiredBinaries?: string[]
  /** Inline-threshold override (bytes) — when outputMode === 'inline',
   * Broker will persist as an artifact if content length exceeds this.
   * If omitted, the broker default (TOOL_OUTPUT_INLINE_MAX_BYTES) applies. */
  inlineMaxBytes?: number
}

/**
 * Wired into the existing ToolDefinition so we can carry CTF metadata alongside
 * the OpenAI-shaped tool spec without re-typing the legacy interface.
 */
export interface RegisteredTool {
  id: string
  domains: ToolDomain[]
  executionMode: ToolExecutionMode
  costClass: ToolCostClass
  outputMode: ToolOutputMode
  riskLevel: ToolRiskLevel
  requiredBinaries?: string[]
  inlineMaxBytes?: number
  /** The underlying Tool implementation — must satisfy the legacy Tool
   * interface (name/definition/concurrencySafe/execute). */
  impl: CTFToolImpl
}

/**
 * Minimal structural type — kept lean to avoid an import cycle with
 * src/core/types.ts. The existing Tool interface is compatible with this.
 */
export interface CTFToolImpl {
  name: string
  concurrencySafe?: boolean
  execute(input: Record<string, unknown>, context: CTFToolContext): Promise<CTFToolResult>
  // Re-exported for the broker to push to the LLM.
  readonly definition: {
    type: 'function'
    function: { name: string; description: string; parameters: unknown }
  }
}

export interface CTFToolResult {
  content: string
  isError: boolean
}

/**
 * A stripped-down context for Tool implementations. Mirrors ToolContext but
 * keeps imports minimal. Concrete implementations widen back to ToolContext
 * via duck typing.
 */
export interface CTFToolContext {
  cwd: string
  permissionMode: 'auto' | 'ask' | 'deny'
  signal?: AbortSignal
  sessionDir?: string
}
