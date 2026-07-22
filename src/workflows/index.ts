/**
 * Workflow catalogue index — registers the 4 starter workflows.
 *
 * Consumers (CLI, tests) import ensureWorkflowsRegistered() at boot to wire
 * the canonical set into a passed-in registry.
 */

import type { WorkflowRegistry } from '../core/workflowRegistry.js'
import { BUILTIN_WORKFLOWS } from './builtins.js'

/**
 * Tracks which workflow ids have been registered on which registries. We
 * previously used a single module-level flag, but that caused silent cross-
 * registry contamination: the first harness's registry would be marked
 * "done" and subsequent fresh registries would stay empty.
 */
const populatedRegistries = new WeakSet<WorkflowRegistry>()

export function ensureWorkflowsRegistered(registry: WorkflowRegistry, opts: { force?: boolean } = {}): void {
  if (!opts.force && populatedRegistries.has(registry)) return
  for (const w of BUILTIN_WORKFLOWS) registry.upsert(w)
  populatedRegistries.add(registry)
}

/** Reset internal cache — for tests that build a fresh registry. */
export function __resetWorkflowRegistrationForTests(): void {
  // WeakSet cannot be cleared; the helper stays for compatibility but is a no-op.
}

export { BUILTIN_WORKFLOWS }
