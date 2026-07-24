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
 *
 * Phase 2.1 — adds `observations`, `evidence`, `strategyDecisions` for the
 * structured reasoning loop.
 */

import type { Finding } from '../findings.js'
import type { TaskExecutionContext } from './taskExecutionContext.js'
import type { Observation } from '../ctfReasoning/observation.js'
import type { Evidence } from '../ctfReasoning/evidence.js'
import type { StrategyDecision } from '../ctfReasoning/strategyDecision.js'
import type { ReasoningBudgetState, ReasoningBudgetLimits } from '../ctfReasoning/reasoningBudget.js'
import type { PendingSuggestedAction } from '../ctfReasoning/pendingActionStore.js'

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
  taskId: string
  statement: string
  category: string
  status: 'proposed' | 'testing' | 'supported' | 'rejected' | 'inconclusive'
  supportingEvidenceIds: string[]
  contradictingEvidenceIds: string[]
  proposedBy: { type: 'planner' | 'workflow' | 'agent' | 'specialist' | 'manual'; id: string }
  priority: number
  confidence: number
  revisionOf?: string
  createdAt: number
  updatedAt: number
}

export interface AttemptExecution {
  index: number
  startedAt: number
  completedAt?: number
  status: 'succeeded' | 'failed' | 'cancelled'
  errorCode?: string
  errorMessage?: string
}

/** §C1 — TaskDiagnostic — a single runtime issue recorded as a
 *  structured entry on `TaskState.diagnostics`. */
export interface TaskDiagnostic {
  kind:
    | 'reasoning_failed'
    | 'workflow_projection_dropped'
    | 'one_shot_cleanup_window'
    | 'lock_deadlock_avoided'
    | 'task_degraded'
  source?: 'main-agent' | 'workflow' | 'oneshot' | 'specialist' | 'manual'
  attemptId?: string
  runId?: string
  workflowRunId?: string
  oneShotRunId?: string
  handoffId?: string
  message: string
  at: number
}

export interface CTFAttempt {
  id: string
  taskId: string
  kind: 'tool' | 'workflow' | 'oneshot' | 'handoff' | 'verification' | 'manual'
  targetId: string
  input: Record<string, unknown>
  fingerprint: string
  hypothesisIds: string[]
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled'
    | 'skipped_duplicate' | 'skipped_policy' | 'skipped_budget'
  observationIds: string[]
  evidenceIds: string[]
  artifactIds: string[]
  flagCandidateIds: string[]
  retryExecutions?: AttemptExecution[]
  error?: { code?: string; message: string; retryable?: boolean }
  startedAt?: number
  completedAt?: number
  createdAt: number
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

/* ─── Phase 2.0 — OneShot first-class execution unit (§三) ─────────────── */

export type OneShotRunStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'partial'
  | 'timeout'
  | 'failed'
  | 'cancelled'
  | 'unavailable'

export const TERMINAL_ONESHOT_STATUSES: ReadonlyArray<OneShotRunStatus> = [
  'completed',
  'partial',
  'timeout',
  'failed',
  'cancelled',
  'unavailable',
]

export function isTerminalOneShotStatus(s: OneShotRunStatus): boolean {
  return TERMINAL_ONESHOT_STATUSES.includes(s)
}

/**
 * OneShotRunRecord — formal lifecycle of a single OneShot invocation. Lives
 * on `CTFTaskState.oneShotRuns` and is updated exclusively via CTFTaskEvents.
 *
 * §三 invariants:
 *   - id is unique within the task.
 *   - backgroundJobId links 1:1 to a BackgroundJobManager entry.
 *   - attemptId links 1:1 to a CTFAttempt.
 *   - status transitions follow the reducer-enforced FSM (no terminal → running).
 */
export interface OneShotRunRecord {
  id: string
  taskId: string

  manifestId: string
  profileId: string

  initiatedByAgentRunId?: string
  initiatedByWorkflowRunId?: string
  handoffId?: string

  backgroundJobId: string
  lane: 'fast' | 'medium' | 'heavy'
  status: OneShotRunStatus

  inputArtifactIds: string[]
  attemptId: string

  findingIds: string[]
  artifactIds: string[]
  flagCandidateIds: string[]

  /** Resolved evidence root (always under the task workspace — §十三). */
  evidenceRoot: string
  /** Optional path to the persisted OneShotResult JSON (§九). */
  resultPath?: string

  queuedAt: number
  startedAt?: number
  completedAt?: number

  summary?: string
  error?: string
}

export interface FlagCandidate {
  id: string
  taskId: string
  value: string
  normalizedValue: string
  sourceObservationIds: string[]
  sourceEvidenceIds: string[]
  sourceArtifactIds: string[]
  sourceRunIds: string[]
  /** §六 — Attempt ids that participated in producing / transforming this candidate. */
  sourceAttemptIds: string[]
  transformChain?: Array<{ operation: string; inputHash: string; outputHash: string }>
  confidence: number
  validation: {
    patternMatched: boolean
    provenanceComplete: boolean
    locallyVerified: boolean
    platformVerified: boolean
    errors: string[]
  }
  status: 'detected' | 'validated' | 'rejected' | 'submitted' | 'accepted'
  source: 'finding' | 'agent_output' | 'workflow_output' | 'manual'
  sourceId?: string
  matchedPattern: boolean
  submittedAt?: number
  submitResult?: 'accepted' | 'rejected' | 'pending'
  notes?: string
  createdAt: number
  updatedAt: number
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

export type SolverRunStatus =
  | 'queued'
  | 'running'
  | 'stagnating'
  | 'paused'
  | 'completed'
  | 'candidate_found'
  | 'gave_up'
  | 'cancelled'
  | 'failed'

export interface SolverRunRecord {
  id: string
  taskId: string
  solverId: string
  solverType: 'native' | 'process' | 'workflow'
  status: SolverRunStatus
  queuedAt: number
  startedAt?: number
  completedAt?: number
  summary?: string
  error?: string
  guidanceMessages?: string[]
  producedCandidateIds?: string[]
  producedEvidenceIds?: string[]
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
  solverRuns: SolverRunRecord[]
  /** Phase 2.0 §三 — OneShot runs as first-class task entities. Filter by
   *  status for "active" subsets. */
  oneShotRuns: OneShotRunRecord[]
  /** Phase 2.1 §六 — structured reasoning artefacts. Each observation
   *  binds a single witnessed fact to a Source; evidence is the claim
   *  built from one or more observations. */
  observations: Observation[]
  evidence: Evidence[]
  /** Phase 2.1 §十六 — every Planner action becomes a StrategyDecision
   *  with the chosen + rejected actions and the reason. */
  strategyDecisions: StrategyDecision[]
  /** Phase 2.2 §二十二 — pending suggested actions awaiting selection. */
  pendingActions: PendingSuggestedAction[]
  /** Phase 2.2 §十一 — cumulative reasoning budget per task. Persists
   *  across restarts so cumulative cost is not refunded. */
  reasoningBudget: ReasoningBudgetState
  /** Phase 2.2 §十一 — per-task budget limits (read-only config). */
  reasoningBudgetLimits: ReasoningBudgetLimits

  /** Convenience: the ids of runs that are currently `running`. Derived
   *  from `agentRuns` / `workflowRuns` / `jobs`. */
  activeAgentRunIds: string[]
  activeWorkflowRunIds: string[]
  activeJobIds: string[]
  activeSolverRunIds: string[]

  flagCandidates: FlagCandidate[]

  completion?: TaskCompletion

  /** §C1 — runtime diagnostics: reasoning failures, FSM
   *  rejections, etc. Read-only via the reducer. */
  diagnostics: TaskDiagnostic[]
  /** §C1 — true after a critical-listener failure or a reasoning
   *  failure. Callers may consult `store.isDegraded()`. */
  degraded: boolean

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
