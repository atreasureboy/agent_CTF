/**
 * CTFToolContext — shared type for the CTF-specific `__ctf` extension on
 * the legacy ToolContext. Every tool that reads `__ctf` should import this
 * interface instead of using `as unknown as { __ctf?: { ... } }` chains.
 *
 * This type is the single source of truth for what the Broker wires into
 * the tool execution context. All `any` / `as unknown as` patterns that
 * previously extracted CTF services from ToolContext must migrate to this
 * interface.
 */

import type { CapabilityProfile } from './capabilityProfile.js'
import type { ContestScopeChecker } from './contestScope.js'
import type { EventLog } from './eventLog.js'
import type { ArtifactStore } from './artifacts.js'
import type { FindingStore } from './findings.js'
import type { HandoffStore } from './handoff.js'
import type { BackgroundJobManager } from './backgroundJobs.js'

export interface CTFToolContext {
  __ctf?: {
    taskId: string
    agentId: string
    profile?: CapabilityProfile
    contestScope?: ContestScopeChecker
    eventLog?: EventLog
    artifactStore?: ArtifactStore
    findingStore?: FindingStore
    handoffStore?: HandoffStore
    /** Phase 1.7 §十三.3 — Run-id propagation for emitted findings/artifacts. */
    agentRunId?: string
    workflowRunId?: string
    handoffId?: string
    jobManager?: BackgroundJobManager
  }
}

/** Shorthand for `context as unknown as CTFToolContext`. Prefer `getCTFContext(context)` below for
 *  safer access that doesn't propagate `unknown` into the caller's scope. */
export function getCTFContext(context: unknown): CTFToolContext['__ctf'] | undefined {
  if (context && typeof context === 'object' && '__ctf' in context) {
    return (context as Record<string, unknown>)['__ctf'] as CTFToolContext['__ctf'] | undefined
  }
  return undefined
}
