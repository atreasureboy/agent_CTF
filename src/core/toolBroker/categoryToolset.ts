/**
 * CategoryToolset — Phase borrow-plan Tier A2 (NYU D-CIPHER pattern).
 *
 * `TOOLSETS['web'] = [FetchURL, RunCommand]`, `TOOLSETS['crypto'] =
 * [Decompile, ...]`. The agent's tool surface is category-specific.
 *
 * This module provides:
 *   - `BUILTIN_TOOLSETS` — suggested groups per category.
 *   - `categoryToolsAllowed(category, toolset)` — boolean predicate.
 *   - `enforceCategoryToolset(broker, category)` — wraps a `ToolBroker`
 *     to reject out-of-scope tool calls.
 */

export type ChallengeCategory = 'web' | 'crypto' | 'pwn' | 'reverse' | 'misc'

export const BUILTIN_TOOLSETS: Record<ChallengeCategory, ReadonlySet<string>> = {
  web: new Set(['webFetch', 'runCommand', 'notifyCoordinator']),
  crypto: new Set(['decompile', 'runCommand', 'strings']),
  pwn: new Set(['decompile', 'runCommand', 'gdb']),
  reverse: new Set(['decompile', 'runCommand', 'strings', 'binwalk']),
  misc: new Set(['runCommand', 'strings']),
}

export interface CategoryToolsetConfig {
  /** Per-category allowlist. A toolId is allowed if it's in the
   *  set for the task's category. */
  perCategory: Record<ChallengeCategory, ReadonlySet<string>>
  /** Tools that are always allowed regardless of category (e.g. the
   *  core shell). */
  universal: ReadonlySet<string>
}

export const DEFAULT_CATEGORY_TOOLSET: CategoryToolsetConfig = {
  perCategory: BUILTIN_TOOLSETS,
  universal: new Set(['runCommand']),
}

export function categoryToolsAllowed(
  config: CategoryToolsetConfig,
  category: ChallengeCategory,
  toolId: string,
): boolean {
  if (config.universal.has(toolId)) return true
  return config.perCategory[category]?.has(toolId) ?? false
}

/** Extract the category from a challenge prompt or a CTFTaskState's
 *  metadata. Defaults to 'misc' if not present. */
export function extractCategory(meta: { category?: string }): ChallengeCategory {
  const c = (meta.category ?? 'misc').toLowerCase()
  if (c === 'web' || c === 'crypto' || c === 'pwn' || c === 'reverse') {
    return c
  }
  return 'misc'
}
