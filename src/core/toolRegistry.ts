/**
 * ToolRegistry — single source of truth for available tools and their CTF
 * metadata. Replaces the bare array-of-Tool-classes returned by
 * src/tools/index.ts#createTools with a queryable, policy-aware registry.
 *
 * Invariants:
 *   - Each tool is registered exactly once by its id.
 *   - `resolveFor(profile)` enforces CapabilityProfile tool boundaries and
 *     returns the implementation objects (in their legacy Tool shape).
 *   - `getOpenAIToolDefinitions(profile)` returns the LLM-visible tool list
 *     filtered by the same Profile rules.
 *   - Existing tests still pass because the legacy createTools() helper
 *     remains and now delegates here under the hood.
 */

import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { join } from 'path'

import type { CapabilityProfile } from './capabilityProfile.js'
import { profileAllowsTool } from './capabilityProfile.js'
import type { CTFToolImpl, CTFToolMetadata, RegisteredTool } from './toolDefinition.js'

interface OpenAIToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: unknown
  }
}

export type { OpenAIToolDefinition }

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>()
  private readonly extraImplTools = new Map<string, CTFToolImpl>()

  /** Register a tool with CTF metadata. */
  register(impl: CTFToolImpl, meta: CTFToolMetadata): void {
    const id = impl.name
    if (this.tools.has(id)) {
      throw new Error(`ToolRegistry: tool "${id}" already registered`)
    }
    this.tools.set(id, {
      id,
      domains: meta.domains,
      executionMode: meta.executionMode,
      costClass: meta.costClass,
      outputMode: meta.outputMode,
      riskLevel: meta.riskLevel ?? 'low',
      requiredBinaries: meta.requiredBinaries,
      inlineMaxBytes: meta.inlineMaxBytes,
      impl,
    })
  }

  /** Register a tool impl without metadata (legacy / extraTools path). */
  registerExtra(impl: CTFToolImpl): void {
    this.extraImplTools.set(impl.name, impl)
  }

  has(id: string): boolean {
    return this.tools.has(id) || this.extraImplTools.has(id)
  }

  /**
   * Retrieve a registered tool. Audit P1 #C1 fix — `get()` previously
   * consulted only the metadata-bearing map, so tools registered via
   * `registerExtra()` (legacy / extraTools path) were "has() === true" but
   * "get() === undefined", causing NPEs in caller patterns like
   * `if (registry.has('Foo')) const reg = registry.get('Foo')`. Extras
   * get a synthesised RegisteredTool with safe defaults so downstream
   * code that does `reg.id` / `reg.executionMode` does not crash.
   */
  get(id: string): RegisteredTool | undefined {
    const primary = this.tools.get(id)
    if (primary) return primary
    const extra = this.extraImplTools.get(id)
    if (extra) {
      return {
        id: extra.name,
        domains: [],
        executionMode: 'either',
        costClass: 'cheap',
        outputMode: 'inline',
        riskLevel: 'low',
        requiredBinaries: undefined,
        inlineMaxBytes: undefined,
        impl: extra,
      }
    }
    return undefined
  }

  /** All registered tools (with metadata) — inspect-only. */
  list(): RegisteredTool[] {
    return [...this.tools.values()]
  }

  /** Filter tools by domain tag (for capability checks + ToolFirstPolicy). */
  listByDomain(domain: string): RegisteredTool[] {
    return this.list().filter((t) => t.domains.includes(domain as never))
  }

  /** Auto-register the legacy Tool instances produced by src/tools/index.ts. */
  static fromLegacyTools(
    legacyTools: CTFToolImpl[],
    metadata: Record<string, CTFToolMetadata>,
  ): ToolRegistry {
    const r = new ToolRegistry()
    for (const impl of legacyTools) {
      const meta = metadata[impl.name]
      if (meta) r.register(impl, meta)
      else r.registerExtra(impl)
    }
    return r
  }

  /**
   * Resolve the implementations that should be exposed to the agent under the
   * given capability profile. Always combined with all extras (extras are
   * session-scoped and assumed safe-by-config).
   */
  resolveFor(profile: CapabilityProfile): CTFToolImpl[] {
    const impls: CTFToolImpl[] = []
    for (const t of this.tools.values()) {
      if (!profileAllowsTool(profile, t.id)) continue
      impls.push(t.impl)
    }
    for (const impl of this.extraImplTools.values()) {
      // Extras inherit the registry boundary; if the profile explicitly
      // denies them, honour that.
      if (!profileAllowsTool(profile, impl.name)) continue
      impls.push(impl)
    }
    return impls
  }

  /**
   * Return the OpenAI-shaped tool definitions, filtered by profile. The model
   * never sees tools outside the profile.
   */
  getOpenAIToolDefinitions(profile: CapabilityProfile): OpenAIToolDefinition[] {
    return this.resolveFor(profile).map((impl) => impl.definition)
  }

  /**
   * Cheap availability check used by the Workflow engine. Returns the list of
   * required binaries that are NOT on PATH. Empty array = tool is available.
   */
  static checkAvailability(
    tool: RegisteredTool,
    pathEnv: string = process.env.PATH ?? '',
  ): string[] {
    if (!tool.requiredBinaries || tool.requiredBinaries.length === 0) return []
    const paths = pathEnv.split(/:+(?:win32[;:]|$)/i).filter(Boolean)
    return tool.requiredBinaries.filter((bin) => {
      return !paths.some((dir) => existsSync(join(dir, bin)))
    })
  }

  /** Compose a stable fingerprint for an artifact tied to a tool+input pair. */
  static fingerprint(id: string, input: Record<string, unknown>): string {
    const h = createHash('sha256')
    h.update(id)
    h.update('\n')
    h.update(JSON.stringify(input ?? {}))
    return h.digest('hex').slice(0, 16)
  }
}
