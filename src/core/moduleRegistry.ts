/**
 * ModuleRegistry — manages module factories and resolves enabled modules.
 *
 * Usage:
 *   const registry = new ModuleRegistry()
 *   registry.register('memory', (ctx) => new MemoryModule(ctx.config.semanticMemory!, ...))
 *   const modules = registry.resolve(['memory', 'critic'], moduleCtx)
 *
 * Resolution order is "leaves → right":
 *   - A module's declared `dependencies` are resolved (and pushed onto
 *     the resolved list) BEFORE the module itself is constructed.
 *   - To resolve dependencies before constructing the consumer, callers
 *     should declare dependencies via `registerWithDeps(name, deps, factory)`.
 *     The fallback path (legacy `register(name, factory)`) reads deps
 *     from the constructed module's `dependencies` field — order is
 *     still correct (deps appear before the consumer in the resolved
 *     list) but the consumer's constructor runs before the deps' ctors.
 */

import type { AgentModule, ModuleFactory, ModuleContext } from './module.js'

export class ModuleRegistry {
  private factories = new Map<string, ModuleFactory>()
  private declaredDeps = new Map<string, string[]>()

  /** Register a module factory by name */
  register(name: string, factory: ModuleFactory): void {
    this.factories.set(name, factory)
  }

  /**
   * Register a module factory with pre-declared dependencies. The registry
   * resolves dependencies BEFORE invoking the factory so a module whose
   * constructor consults sibling modules' state observes the correct order.
   *
   * The module's `dependencies` field, if set, is still respected when this
   * overload is used (the union of declared deps + module-level deps).
   */
  registerWithDeps(name: string, deps: string[], factory: ModuleFactory): void {
    this.factories.set(name, factory)
    this.declaredDeps.set(name, deps)
  }

  /** Check if a module is registered */
  has(name: string): boolean {
    return this.factories.has(name)
  }

  /**
   * Resolve a list of enabled module names into instantiated modules.
   * Dependencies are resolved automatically (depth-first, deduplicated).
   *
   * Failure modes (previously silent — now surfaced):
   *   - A dependency cycle raises an Error immediately. A cycle is a programming
   *     bug that would otherwise produce a silently truncated module list.
   *   - An unknown/unregistered name logs a warning and is skipped, so a typo in
   *     config degrades gracefully instead of vanishing without a trace.
   */
  resolve(enabledNames: string[], ctx: ModuleContext): AgentModule[] {
    const resolved: AgentModule[] = []
    const seen = new Set<string>()
    const inProgress = new Set<string>()  // cycle detection

    const resolveOne = (name: string, chain: string[]): void => {
      if (seen.has(name)) return
      if (inProgress.has(name)) {
        const cyclePath = [...chain, name].join(' → ')
        throw new Error(`ModuleRegistry: dependency cycle detected (${cyclePath})`)
      }
      const factory = this.factories.get(name)
      if (!factory) {
        // Surface the typo instead of silently dropping it. eventLog is the
        // project's audit channel; best-effort (skips when no session is active).
        ctx.config.eventLog?.append('module_error', 'ModuleRegistry', {
          unknown_module: name,
          note: 'not registered, skipping',
        })
        return
      }

      // Pre-declared deps (from registerWithDeps) are resolved BEFORE the
      // factory runs so the consumer module's constructor observes the
      // correct resolution order. Module.dependencies (post-construction) is
      // still respected for the legacy `register(name, factory)` path.
      const preDeps = this.declaredDeps.get(name) ?? []

      inProgress.add(name)
      // Resolve pre-declared deps first (leaves → right)
      for (const dep of preDeps) {
        resolveOne(dep, [...chain, name])
      }

      const module = factory(ctx)

      // Resolve the module's own declared dependencies (legacy path). The
      // push order remains correct: deps are pushed before the consumer.
      for (const dep of module.dependencies ?? []) {
        if (seen.has(dep) || preDeps.includes(dep)) continue
        resolveOne(dep, [...chain, name])
      }

      inProgress.delete(name)
      seen.add(name)
      resolved.push(module)
    }

    for (const name of enabledNames) {
      resolveOne(name, [])
    }

    return resolved
  }
}

/** Global default registry — populated at startup by bin/ovogogogo.ts */
export const globalModuleRegistry = new ModuleRegistry()
