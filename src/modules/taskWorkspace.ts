/**
 * TaskWorkspace — per-task working directory and isolation primitive.
 *
 * Replaces the legacy single-session-dir model with the canonical CTF layout:
 *   sessions/<contestId>/tasks/<taskId>/
 *     input/       — read-only task input (题目原文)
 *     workspace/   — current Agent/Job working directory (mutations allowed)
 *     artifacts/   — long outputs persisted as files (sha256 + summary)
 *     findings/    — <taskId>.jsonl of structured findings
 *     agents/<runId>/ — per-agent scratch
 *     jobs/        — per-job state + index.jsonl
 *     events.ndjson  — event log
 *
 * The Module exposes Boot patches so that Tools/Broker can locate the task
 * workspace without each tool having to be told explicitly.
 */

import { mkdirSync, existsSync } from 'fs'
import { dirname, join, resolve, sep } from 'path'
import { randomBytes } from 'crypto'

import type { AgentModule, ModuleBootContext, ModuleBootResult } from '../core/module.js'
import type { ArtifactStore } from '../core/artifacts.js'
import { ArtifactStore as ArtifactStoreImpl } from '../core/artifacts.js'
import type { FindingStore } from '../core/findings.js'
import { FindingStore as FindingStoreImpl } from '../core/findings.js'
import type { HandoffStore } from '../core/handoff.js'
import { HandoffStore as HandoffStoreImpl } from '../core/handoff.js'

export interface TaskWorkspacePaths {
  contestId: string
  taskId: string
  root: string
  inputDir: string
  workspaceDir: string
  artifactsDir: string
  findingsFile: string
  agentsDir: string
  jobsDir: string
  eventsFile: string
}

export interface TaskWorkspaceOptions {
  sessionsRoot: string // usually <project>/sessions
  contestId: string
  taskId: string
  workspaceSubdir?: string // default 'workspace'
  /** Read-only root for inputs (default: input/). */
  inputSubdir?: string
}

export class TaskWorkspace {
  readonly paths: TaskWorkspacePaths
  readonly artifactStore: ArtifactStore
  readonly findingStore: FindingStore
  readonly handoffStore: HandoffStore

  constructor(opts: TaskWorkspaceOptions) {
    const root = resolve(opts.sessionsRoot, opts.contestId, 'tasks', opts.taskId)
    const paths: TaskWorkspacePaths = {
      contestId: opts.contestId,
      taskId: opts.taskId,
      root,
      inputDir: join(root, opts.inputSubdir ?? 'input'),
      workspaceDir: join(root, opts.workspaceSubdir ?? 'workspace'),
      artifactsDir: join(root, 'artifacts'),
      findingsFile: join(root, 'findings.jsonl'),
      agentsDir: join(root, 'agents'),
      jobsDir: join(root, 'jobs'),
      eventsFile: join(root, 'events.ndjson'),
    }
    for (const dir of [
      root,
      paths.inputDir,
      paths.workspaceDir,
      paths.artifactsDir,
      paths.agentsDir,
      paths.jobsDir,
    ]) {
      mkdirSync(dir, { recursive: true })
    }
    this.paths = paths
    this.artifactStore = new ArtifactStoreImpl(root)
    this.findingStore = new FindingStoreImpl(root)
    this.handoffStore = new HandoffStoreImpl(root)
  }

  /** Allocate a unique sub-directory for a single agent run. */
  allocateAgentRun(): string {
    const runId = `run_${randomBytes(6).toString('hex')}`
    const dir = join(this.paths.agentsDir, runId)
    mkdirSync(dir, { recursive: true })
    return dir
  }

  /** Resolve a path; throws if the resolved path leaves the workspace root. */
  resolveWithinWorkspace(p: string): string {
    // Audit P0 #B2 fix — the previous `abs.startsWith(ws)` accepted
    // sibling-prefix directories like `/<root>-evil` as "inside" the
    // workspace. Require either exact equality OR a trailing separator
    // after the workspace root, mirroring contestScope.ts:104-111.
    // Also rejects leading-slash inputs that resolve to absolute
    // paths outside the workspace, which `resolve()` does not catch.
    const abs = resolve(p)
    const ws = resolve(this.paths.workspaceDir)
    if (abs !== ws && !abs.startsWith(ws + sep)) {
      throw new Error(`Path "${p}" is outside the task workspace.`)
    }
    return abs
  }

  getEventLogPath(): string {
    return this.paths.eventsFile
  }

  exists(): boolean {
    return existsSync(this.paths.root)
  }
}

/**
 * Module wrapper so the engine can expose TaskWorkspace via
 * ToolContext (the workspace dir doubles as sessionDir, plus the extras are
 * added as ad-hoc patch).
 */
export class TaskWorkspaceModule implements AgentModule {
  readonly name = 'taskWorkspace'

  constructor(private readonly workspace: TaskWorkspace) {}

  boot(_ctx: ModuleBootContext): ModuleBootResult {
    return {
      toolContextPatch: {
        sessionDir: this.workspace.paths.workspaceDir,
      },
    }
  }
}

/**
 * Generate a stable taskId for a session (UUIDv4-like hex).
 * Production code should feed IDs from the contest's task allocator.
 */
export function makeTaskId(prefix: string = 'task'): string {
  return `${prefix}_${randomBytes(6).toString('hex')}`
}

/** Generate a contestId from a project path or user input. */
export function makeContestId(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || 'contest'
  )
}

export const _internals = { dirname }
