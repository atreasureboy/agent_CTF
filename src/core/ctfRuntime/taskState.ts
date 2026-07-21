/**
 * CTFTaskState — the single authoritative state of one CTF task.
 *
 * Phase / Profile / Handoff / Specialist Run / Workflow Run / Background Job /
 * Flag candidates are ALL owned here. The state goes through
 * `CTFTaskStateStore.apply(event)` — direct mutation is forbidden.
 *
 * The store does NOT duplicate the persistence layer (FindingStore,
 * ArtifactStore, HandoffStore). Those continue to be the durable backing for
 * findings/artifacts/handoffs; the TaskState keeps only the **indices** plus
 * derived information (phase, attempts, hypotheses, completions).
 */

import type { Finding } from '../findings.js'
import type { TaskExecutionContext } from './taskExecutionContext.js'

export type CTFTaskPhase =
  | 'created'
  | 'intake'
  | 'triage'
  | 'exploration'
  | 'specialist_execution'
  | 'verification'
  | 'solved'
  | 'blocked'
  | 'failed'
  | 'cancelled'

export const TERMINAL_TASK_PHASES: ReadonlyArray<CTFTaskPhase> = [
  'solved',
  'blocked',
  'failed',
  'cancelled',
]

export interface ChallengeDescriptor {
  description?: string
  category?: string
  /** Regex / literal expected flag shape (e.g. `flag\{[^}]+\}`). */
  flagPattern?: string
  /** Initial artifact ids supplied to the task. */
  inputArtifactIds: string[]
}

export interface CTFHypothesis {
  id: string
  statement: string
  status: 'proposed' | 'testing' | 'supported' | 'rejected' | 'inconclusive'
  evidenceIds: string[]
  createdBy: string
  createdAt: number
  updatedAt: number
}

export interface CTFAttempt {
  id: string
  kind: 'tool' | 'workflow' | 'agent' | 'manual'
  summary: string
  /** Optional fingerprint for repeat-detection (e.g. toolId+input hash). */
  fingerprint?: string
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  resultSummary?: string
  createdAt: number
  completedAt?: number
}

export type HandoffRecordStatus =
  | 'requested'
  | 'approved'
  | 'rejected'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface HandoffRecord {
  id: string
  taskId: string
  /** Agent run id that requested the handoff. */
  fromAgentRunId: string
  requestedCapability: string
  requestedAgentId?: string
  /** Resolved at approval time. */
  selectedAgentId?: string
  reason: string
  objective: string
  artifactIds: string[]
  findingIds: string[]
  constraints?: string[]
  priority?: number
  status: HandoffRecordStatus
  createdAt: number
  approvedAt?: number
  startedAt?: number
  completedAt?: number
  rejectionReason?: string
  error?: string
}

export interface AgentRunRecord {
  id: string
  taskId: string
  parentAgentRunId?: string
  /** Profile id used by this run. */
  profileId: string
  /** Resolved Context id (matches `TaskExecutionContext.taskId` for the
   *  sub-harness, equals the main task id for the main agent). */
  contextTaskId: string
  /** Linked handoff id when the run was spawned from a handoff. */
  handoffId?: string
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  startedAt: number
  completedAt?: number
  /** Inherited artifacts from the parent task. */
  inheritedArtifactIds: string[]
  /** Inherited findings from the parent task. */
  inheritedFindingIds: string[]
  /** Findings produced by THIS run (id refs into the global finding list). */
  producedFindingIds: string[]
  /** Artifacts produced by THIS run (id refs into the global artifact list). */
  producedArtifactIds: string[]
  /** Optional summary line. */
  summary?: string
  error?: string
}

export interface WorkflowRunRecord {
  id: string
  taskId: string
  workflowId: string
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  startedAt: number
  completedAt?: number
  summary?: string
  error?: string
  /** Profile id active when the workflow started. Preserved across the
   *  lifecycle so audit can answer "which profile was running this?". */
  profileId?: string
  /** Agent run that initiated the workflow. */
  initiatedByAgentRunId?: string
  /** Step outcomes — light refs (id + status). */
  stepOutcomeIds: string[]
}

export interface JobRecord {
  id: string
  taskId: string
  agentRunId?: string
  workflowRunId?: string
  status: 'pending' | 'running' | 'success' | 'failed' | 'cancelled'
  startedAt: number
  endedAt?: number
  summary?: string
}

export interface FlagCandidate {
  id: string
  taskId: string
  value: string
  source: 'finding' | 'agent_output' | 'workflow_output' | 'manual'
  sourceId?: string
  confidence: 'low' | 'medium' | 'high'
  /** Whether the candidate matched `challenge.flagPattern`. */
  matchedPattern: boolean
  submittedAt?: number
  submitResult?: 'accepted' | 'rejected' | 'pending'
  notes?: string
  createdAt: number
}

export interface TaskCompletion {
  status: 'solved' | 'blocked' | 'failed' | 'cancelled'
  reason: string
  flagCandidateId?: string
  decidedAt: number
}

export interface AgentRunResult {
  agentRunId: string
  profileId: string
  status: 'completed' | 'failed' | 'cancelled'
  summary?: string
  error?: string
  producedFindingIds: string[]
  producedArtifactIds: string[]
}

export interface CTFTaskState {
  taskId: string
  phase: CTFTaskPhase

  context: TaskExecutionContext

  challenge: ChallengeDescriptor

  /** Active profile id; the source of truth — broker / workflow read this. */
  activeProfileId: string

  /** Index of all findings (canonical list lives in FindingStore). */
  findings: Finding[]
  /** Index of all artifacts (canonical list lives in ArtifactStore). */
  artifactIds: string[]

  hypotheses: CTFHypothesis[]
  attempts: CTFAttempt[]

  handoffs: HandoffRecord[]

  /** §九 — these fields are HISTORICAL records, not "active sets". A caller
   *  that wants only the currently-running subset can filter by `status`. */
  agentRuns: AgentRunRecord[]
  workflowRuns: WorkflowRunRecord[]
  jobs: JobRecord[]
  /** Convenience: the ids of runs that are currently `running`. Derived
   *  from `agentRuns` / `workflowRuns` / `jobs`. */
  activeAgentRunIds: string[]
  activeWorkflowRunIds: string[]
  activeJobIds: string[]

  flagCandidates: FlagCandidate[]

  completion?: TaskCompletion

  createdAt: number
  updatedAt: number
}

/** Predicate: an AgentRunRecord is "active" iff status === 'running'. */
export function isActiveAgentRun(r: AgentRunRecord): boolean {
  return r.status === 'running'
}
export function isActiveWorkflowRun(r: WorkflowRunRecord): boolean {
  return r.status === 'running'
}
export function isActiveJob(j: JobRecord): boolean {
  return j.status === 'pending' || j.status === 'running'
}

/**
 * Allowed phase transitions. The store refuses anything not listed here.
 *
 * created → intake → triage → exploration ↔ specialist_execution → verification → solved
 * any non-terminal → blocked / failed / cancelled
 */
export const ALLOWED_PHASE_TRANSITIONS: Readonly<Record<CTFTaskPhase, ReadonlyArray<CTFTaskPhase>>> = {
  created: ['intake', 'blocked', 'failed', 'cancelled'],
  intake: ['triage', 'blocked', 'failed', 'cancelled'],
  triage: ['exploration', 'blocked', 'failed', 'cancelled'],
  exploration: ['specialist_execution', 'verification', 'blocked', 'failed', 'cancelled'],
  specialist_execution: ['exploration', 'verification', 'blocked', 'failed', 'cancelled'],
  verification: ['solved', 'exploration', 'blocked', 'failed', 'cancelled'],
  solved: [],
  blocked: [],
  failed: [],
  cancelled: [],
}

export function isTerminalPhase(p: CTFTaskPhase): boolean {
  return TERMINAL_TASK_PHASES.includes(p)
}

export function canTransitionPhase(from: CTFTaskPhase, to: CTFTaskPhase): boolean {
  return ALLOWED_PHASE_TRANSITIONS[from].includes(to)
}
