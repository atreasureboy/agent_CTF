/**
 * Workflow catalogue index — registers the 4 starter workflows.
 *
 * Consumers (CLI, tests) import ensureWorkflowsRegistered() at boot to wire
 * the canonical set into a passed-in registry.
 */

import { WorkflowRegistry } from '../core/workflowRegistry.js'
import { BUILTIN_WORKFLOWS } from './builtins.js'

let registeredOnce = false

export function ensureWorkflowsRegistered(registry: WorkflowRegistry, opts: { force?: boolean } = {}): void {
  if (registeredOnce && !opts.force) return
  for (const w of BUILTIN_WORKFLOWS) registry.upsert(w)
  registeredOnce = true
}

/** Reset internal cache — for tests that build a fresh registry. */
export function __resetWorkflowRegistrationForTests(): void {
  registeredOnce = false
}

export { BUILTIN_WORKFLOWS }
