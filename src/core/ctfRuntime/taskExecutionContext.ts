/**
 * TaskExecutionContext — single authoritative execution context per CTF task.
 *
 * A CTF task carries exactly one `TaskExecutionContext` instance. The
 * Orchestrator constructs it; every downstream component (Harness, ToolBroker,
 * WorkflowRunner, Specialist creation) reads from it instead of consulting
 * `process.cwd()`, ad-hoc env vars, or scattered module fields.
 *
 * Subtasks (Specialist harnesses, ephemeral workflows) MUST be derived via
 * `deriveSubtaskContext()` so that Scope narrowing + workspace containment
 * invariants hold.
 */

import type { ContestScope } from '../contestScope.js'
import type { ContestConfig } from '../contestConfig.js'

export interface TaskExecutionContext {
  readonly taskId: string

  /** Mutable working directory for tool / workflow execution. */
  readonly workspaceDir: string
  /** Per-session scratch directory. */
  readonly sessionDir: string
  /** Artifact root. All persisted outputs live under here. */
  readonly artifactDir: string
  /** Optional read-only input directory (题目原文). */
  readonly inputDir?: string
  /** Events file (NDJSON, append-only). */
  readonly eventsFile: string

  /** Active Profile id. This is the SOLE owner of "what profile is current". */
  readonly profileId: string

  /** Runtime Scope gate (file + network). */
  readonly contestScope: ContestScope
  /** Declarative Contest config (loaded from .ovogo/contest.json). */
  readonly contestConfig: ContestConfig

  /** Optional environment injection (rarely needed; defaults to process.env). */
  readonly environment?: Readonly<Record<string, string>>

  /** Cooperative abort — set by Orchestrator.cancel(). */
  readonly abortSignal?: AbortSignal

  /** Parent task id when this context was derived from another task. */
  readonly parentTaskId?: string

  /** Free-form metadata for audit + grep. */
  readonly metadata?: Readonly<Record<string, unknown>>
}

export interface SubtaskContextOptions {
  subtaskId: string
  /** Override workspace dir (e.g. `<root>/agents/<runId>`). */
  workspaceDir?: string
  /** Override session dir. Defaults to the parent's sessionDir. */
  sessionDir?: string
  /** Override artifact dir. Defaults to a sub-dir under parent's artifactDir. */
  artifactDir?: string
  /** Optional narrower contestScope. Narrower means "fewer allowHosts / etc."
   *  We refuse to accept a broader scope and throw. */
  contestScope?: ContestScope
  /** Subtask's own profile id (defaults to parent's). */
  profileId?: string
  /** Optional metadata merged into the derived context. */
  metadata?: Record<string, unknown>
}

/**
 * Derive a sub-task context. Enforces scope-narrowing invariant:
 *   derived.contestScope allow-set ⊆ parent.contestScope allow-set
 *
 * Throws on attempted widening so Specialists can never escalate beyond the
 * parent task's authority.
 */
export function deriveSubtaskContext(
  parent: TaskExecutionContext,
  opts: SubtaskContextOptions,
): TaskExecutionContext {
  const mergedScope = opts.contestScope
    ? narrowContestScope(parent.contestScope, opts.contestScope)
    : parent.contestScope

  const root = parent.metadata?.['projectRoot'] as string | undefined
  const parentEnv = (parent.environment ?? {}) as Record<string, string>
  return {
    taskId: opts.subtaskId,
    workspaceDir: opts.workspaceDir ?? parent.workspaceDir,
    sessionDir: opts.sessionDir ?? parent.sessionDir,
    artifactDir:
      opts.artifactDir ?? joinUnder(parent.artifactDir, opts.subtaskId),
    inputDir: parent.inputDir,
    eventsFile: joinUnder(parent.sessionDir, 'events.ndjson'),
    profileId: opts.profileId ?? parent.profileId,
    contestScope: mergedScope,
    contestConfig: parent.contestConfig,
    environment: parentEnv,
    abortSignal: parent.abortSignal,
    parentTaskId: parent.taskId,
    metadata: {
      ...(parent.metadata ?? {}),
      ...(opts.metadata ?? {}),
      derivedFrom: parent.taskId,
      // Mark the project root for tooling that needs to resolve paths even
      // when the workspace has been redirected to a sandbox dir.
      ...(root ? { projectRoot: root } : {}),
    },
  }
}

function joinUnder(parent: string, child: string): string {
  // No leading slash so we always stay under the parent.
  const safe = child.replace(/^\/+/, '').replace(/\.\.+/g, '_')
  if (parent.endsWith('/')) return parent + safe
  return `${parent}/${safe}`
}

/**
 * Return a Scope that is the intersection of two scopes. If `child` declares
 * anything broader than `parent` (more allowedHosts, allowPublicNetwork=true
 * when parent=false, etc.) we throw — Specialists must not widen authority.
 */
export function narrowContestScope(
  parent: ContestScope,
  child: ContestScope,
): ContestScope {
  if (parent.allowPublicNetwork && !child.allowPublicNetwork) {
    // Public → restricted is a narrowing, OK.
  } else if (!parent.allowPublicNetwork && child.allowPublicNetwork) {
    throw new ScopeNarrowingError(
      'Derived contestScope widens allowPublicNetwork=true; refused.',
    )
  }

  const narrowList = <T>(parentList: T[] | undefined, childList: T[] | undefined): T[] | undefined => {
    if (childList === undefined) return parentList
    const parentSet = new Set(parentList ?? [])
    for (const v of childList) {
      if (!parentSet.has(v)) {
        throw new ScopeNarrowingError(`Derived contestScope widens allow-list (${String(v)}).`)
      }
    }
    return childList
  }

  const parentFilesRoot = parent.allowedFilesRoot
  const childFilesRoot = child.allowedFilesRoot
  if (!isPathWithin(childFilesRoot, parentFilesRoot)) {
    throw new ScopeNarrowingError(
      `Derived allowedFilesRoot "${childFilesRoot}" is outside parent root "${parentFilesRoot}".`,
    )
  }

  return {
    allowedFilesRoot: childFilesRoot,
    allowPublicNetwork: child.allowPublicNetwork,
    allowHeavyOneShots: child.allowHeavyOneShots,
    allowedHosts: narrowList(parent.allowedHosts, child.allowedHosts),
    allowedCidrs: narrowList(parent.allowedCidrs, child.allowedCidrs),
    allowedDomains: narrowList(parent.allowedDomains, child.allowedDomains),
    allowedPorts: narrowList(parent.allowedPorts, child.allowedPorts),
  }
}

function isPathWithin(child: string, parent: string): boolean {
  const a = child.replace(/\/+$/, '')
  const b = parent.replace(/\/+$/, '')
  return a === b || a.startsWith(b + '/')
}

export class ScopeNarrowingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ScopeNarrowingError'
  }
}
