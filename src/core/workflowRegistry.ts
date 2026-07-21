/**
 * WorkflowRegistry — declarative catalogue of named Workflows.
 *
 * The Registry indexes workflows by id and supports:
 *   - register / get / list
 *   - resolveFor(profile): filter by capability profile (allowedWorkflows / deniedWorkflows)
 *   - toolDependencyCheck(profile, registry): list missing tool ids
 */

import type { CapabilityProfile } from './capabilityProfile.js'
import { profileAllowsWorkflow } from './capabilityProfile.js'
import type { ToolRegistry } from './toolRegistry.js'
import type { WorkflowDefinition } from './workflowDefinition.js'

export class WorkflowRegistry {
  private readonly workflows = new Map<string, WorkflowDefinition>()

  register(workflow: WorkflowDefinition, opts: { replace?: boolean } = {}): void {
    if (this.workflows.has(workflow.id) && !opts.replace) {
      throw new Error(`WorkflowRegistry: workflow "${workflow.id}" already registered`)
    }
    this.workflows.set(workflow.id, workflow)
  }

  /** Idempotent register — overwrite if exists, never throw. */
  upsert(workflow: WorkflowDefinition): void {
    this.workflows.set(workflow.id, workflow)
  }

  has(id: string): boolean {
    return this.workflows.has(id)
  }

  get(id: string): WorkflowDefinition | undefined {
    return this.workflows.get(id)
  }

  list(): WorkflowDefinition[] {
    return [...this.workflows.values()]
  }

  listVisible(profile: CapabilityProfile): WorkflowDefinition[] {
    return this.list().filter((w) => profileAllowsWorkflow(profile, w.id))
  }

  /** Tools that the workflow needs but the registry does not yet declare.
   * Useful for surfacing configuration gaps at boot, not for runtime gating. */
  toolDependencyIssues(registry: ToolRegistry): { toolId: string; missing: boolean }[] {
    const issues: { toolId: string; missing: boolean }[] = []
    for (const w of this.workflows.values()) {
      for (const toolId of w.requiredTools) {
        issues.push({ toolId, missing: !registry.has(toolId) })
      }
    }
    return issues
  }
}
