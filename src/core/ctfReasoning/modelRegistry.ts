/**
 * ModelRegistry — Phase borrow-plan Tier C2 (CAI pattern).
 *
 * CAI's `_MODEL_REGISTRY` maps `agent_id → model`. Each agent
 * type (bug_bounter, red_teamer, web_pentester) is paired with
 * a specific model backend. The lookup happens before each turn.
 *
 * Our `ModelRegistry`:
 *   - `register(role, backend)` registers a backend for a role.
 *   - `lookup(role)` returns the backend for a role, with
 *     fallback to a default.
 *   - `fallback` chain: the registry can have a primary +
 *     secondary backend per role; if primary fails, secondary
 *     is tried.
 *   - `setActiveBackend(role, backendId)` swaps the active model
 *     mid-task.
 *
 * Pure: this module is a registry + selection logic. Concrete model
 * adapters (Claude / GPT-4 / Qwen-coder) are out of scope; the
 * registry stores opaque backend ids.
 */

export type BackendId = string & { __brand: 'BackendId' }

export function backendId(s: string): BackendId {
  return s as BackendId
}

export type RoleModelConfig = {
  primary: BackendId
  secondary?: BackendId
}

export type RoleModels = {
  [role: string]: RoleModelConfig
}

export class ModelRegistry {
  private readonly models: Map<string, RoleModelConfig> = new Map()
  private readonly activeBackends: Map<string, BackendId> = new Map()
  private readonly defaultBackend: BackendId

  constructor(opts: { defaultBackend: BackendId; roles?: RoleModels } = { defaultBackend: backendId('claude-3-5-sonnet') }) {
    this.defaultBackend = opts.defaultBackend
    if (opts.roles) {
      for (const [role, cfg] of Object.entries(opts.roles)) {
        this.models.set(role, cfg)
        this.activeBackends.set(role, cfg.primary)
      }
    }
  }

  register(role: string, config: RoleModelConfig): void {
    this.models.set(role, config)
    if (!this.activeBackends.has(role)) {
      this.activeBackends.set(role, config.primary)
    }
  }

  lookup(role: string): BackendId {
    return this.activeBackends.get(role) ?? this.defaultBackend
  }

  setActiveBackend(role: string, backend: BackendId): void {
    if (!this.models.has(role)) {
      this.models.set(role, { primary: backend })
    }
    this.activeBackends.set(role, backend)
  }

  /** Return the next backend in the fallback chain. Returns
   *  undefined when there is no fallback. */
  fallback(role: string): BackendId | undefined {
    const cfg = this.models.get(role)
    return cfg?.secondary
  }

  /** List all registered roles. */
  roles(): string[] {
    return [...this.models.keys()]
  }
}

/** A simple round-robin swapper: cycles between primary and
 *  secondary every N turns. Used by the Coordinator to alternate
 *  models within a single task. */
export class RoundRobinSwap {
  private count = 0
  constructor(private readonly n: number = 2) {}

  /** Returns true when the swapper wants to swap on this call. */
  shouldSwap(): boolean {
    this.count += 1
    return this.count % this.n === 0
  }

  reset(): void {
    this.count = 0
  }
}
