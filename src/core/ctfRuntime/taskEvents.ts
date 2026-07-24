/**
 * CTFTaskEvent — the union of all state-changing events for a CTF task.
 *
 * Every mutation of `CTFTaskState` flows through `CTFTaskStateStore.apply()`,
 * which dispatches on `event.type` and emits derived events to subscribers.
 *
 * This event system is intentionally minimal:
 *   - In-process (no EventBus, no Redis, no DB)
 *   - Discriminated union (TypeScript guarantees exhaustiveness)
 *   - Reducer-style: each event produces a NEW state object
 *   - Subscribers see only `Readonly<CTFTaskState>` snapshots
 */

import type {
  AgentRunRecord,
  CTFAttempt,
  CTFHypothesis,
  CTFTaskPhase,
  CTFTaskState,
  FlagCandidate,
  HandoffRecord,
  JobRecord,
  OneShotRunRecord,
  OneShotRunStatus,
  WorkflowRunRecord,
} from './taskState.js'
import type { Finding } from '../findings.js'
import type { Observation } from '../ctfReasoning/observation.js'
import type { Evidence } from '../ctfReasoning/evidence.js'
import type { StrategyDecision } from '../ctfReasoning/strategyDecision.js'
import type { PendingSuggestedAction } from '../ctfReasoning/pendingActionStore.js'
import type { ReasoningBudgetState } from '../ctfReasoning/reasoningBudget.js'

export type CTFTaskEvent =
  | { type: 'TASK_CREATED'; taskId: string; initial: CTFTaskState }
  | { type: 'PHASE_CHANGED'; from: CTFTaskPhase; to: CTFTaskPhase; reason?: string }
  | { type: 'PROFILE_CHANGED'; previousProfileId: string; profileId: string }
  | { type: 'CONTEXT_REPLACED'; context: CTFTaskState['context'] }
  | { type: 'WORKFLOW_STARTED'; workflowRun: WorkflowRunRecord }
  | { type: 'WORKFLOW_COMPLETED'; workflowRunId: string; summary?: string }
  | { type: 'WORKFLOW_FAILED'; workflowRunId: string; error: string }
  | { type: 'WORKFLOW_CANCELLED'; workflowRunId: string; reason: string }
  | { type: 'HANDOFF_REQUESTED'; handoff: HandoffRecord }
  | { type: 'HANDOFF_APPROVED'; handoffId: string; selectedAgentId: string }
  | { type: 'HANDOFF_REJECTED'; handoffId: string; reason: string }
  | { type: 'HANDOFF_CANCELLED'; handoffId: string; reason: string }
  // TODO(§11 follow-up): widen `stage` back to
  //   'selection' | 'creation' | 'execution' | 'projection'
  // once `runSpecialist` (handoffCoordinator.ts) emits 'creation' on
  // factory failure, 'execution' on engineOut rejection, and
  // 'projection' on projectDiff failure. Today only 'selection' is
  // actually produced (in approveAndRun when no agent matches the
  // requested capability); shipping the broader union would just add
  // unused type branches that no code emits.
  | {
      type: 'HANDOFF_FAILED'
      handoffId: string
      stage: 'selection'
      error: string
    }
  // Per next_goal.md §五 — Specialist events carry the HandoffRecord id so
  // the link between a Handoff and the run it spawned is preserved.
  | { type: 'SPECIALIST_STARTED'; handoffId: string; agentRun: AgentRunRecord }
  | { type: 'SPECIALIST_COMPLETED'; handoffId: string; agentRunId: string; summary?: string }
  | { type: 'SPECIALIST_FAILED'; handoffId: string; agentRunId: string; error: string }
  | { type: 'SPECIALIST_CANCELLED'; handoffId: string; agentRunId: string; reason: string }
  | { type: 'AGENT_RUN_STARTED'; agentRun: AgentRunRecord }
  | { type: 'AGENT_RUN_COMPLETED'; agentRunId: string; summary?: string }
  | { type: 'AGENT_RUN_FAILED'; agentRunId: string; error: string }
  | { type: 'AGENT_RUN_CANCELLED'; agentRunId: string; reason: string }
  | { type: 'AGENT_RUN_OUTPUT_RECORDED'; agentRunId: string; producedFindingIds: string[]; producedArtifactIds: string[] }
  | { type: 'FINDING_ADDED'; finding: Finding }
  | { type: 'ARTIFACT_ADDED'; artifactId: string }
  | { type: 'FLAG_CANDIDATE_ADDED'; candidate: FlagCandidate }
  // §九 — Hypothesis/Attempt/Job events now carry the full object so the
  // reducer can actually update state. The old "id-only" variants caused
  // silent state divergence.
  | { type: 'HYPOTHESIS_ADDED'; hypothesis: CTFHypothesis }
  | { type: 'HYPOTHESIS_UPDATED'; hypothesisId: string; patch: Partial<CTFHypothesis> }
  | { type: 'ATTEMPT_RECORDED'; attempt: CTFAttempt }
  | { type: 'ATTEMPT_UPDATED'; attemptId: string; patch: Partial<CTFAttempt> }
  | { type: 'JOB_RECORDED'; job: JobRecord }
  | { type: 'JOB_UPDATED'; jobId: string; patch: Partial<JobRecord> }
  /* ─── Phase 2.0 §四 — OneShot first-class task events ────────────────── */
  | { type: 'ONESHOT_RUN_QUEUED'; run: OneShotRunRecord }
  | {
      type: 'ONESHOT_RUN_STARTED'
      runId: string
      backgroundJobId: string
      startedAt: number
    }
  | {
      type: 'ONESHOT_RUN_COMPLETED'
      runId: string
      summary: string
      findingIds: string[]
      artifactIds: string[]
      flagCandidateIds: string[]
      completedAt: number
    }
  | {
      type: 'ONESHOT_RUN_PARTIAL'
      runId: string
      summary: string
      completedAt: number
    }
  | {
      type: 'ONESHOT_RUN_FAILED'
      runId: string
      error: string
      completedAt: number
    }
  | {
      type: 'ONESHOT_RUN_TIMEOUT'
      runId: string
      error?: string
      completedAt: number
    }
  | {
      type: 'ONESHOT_RUN_CANCELLED'
      runId: string
      reason: string
      completedAt: number
    }
  | {
      type: 'ONESHOT_RUN_UPDATED'
      runId: string
      patch: Partial<OneShotRunRecord>
    }
  | { type: 'TASK_COMPLETED'; status: 'solved' | 'blocked' | 'failed' | 'cancelled'; reason: string; flagCandidateId?: string }
  /* ─── Phase 2.1 §六 — structured reasoning events ──────────────────── */
  | { type: 'OBSERVATION_ADDED'; observation: Observation }
  | { type: 'EVIDENCE_ADDED'; evidence: Evidence }
  | {
      type: 'EVIDENCE_UPSERTED'
      evidence: Evidence
      created: boolean
    }
  | { type: 'EVIDENCE_MERGED'; evidenceId: string; mergedFrom: string }
  | { type: 'HYPOTHESIS_PROPOSED'; hypothesis: CTFHypothesis }
  | { type: 'HYPOTHESIS_STATUS_CHANGED'; hypothesisId: string; from: CTFHypothesis['status']; to: CTFHypothesis['status']; reason?: string }
  | { type: 'ATTEMPT_STARTED'; attempt: CTFAttempt }
  | {
      type: 'ATTEMPT_COMPLETED'
      attemptId: string
      status: CTFAttempt['status']
      observationIds: string[]
      evidenceIds: string[]
      artifactIds: string[]
      flagCandidateIds: string[]
      completedAt: number
    }
  | {
      type: 'ATTEMPT_FAILED'
      attemptId: string
      error: { code?: string; message: string; retryable?: boolean }
      observationIds: string[]
      evidenceIds: string[]
      completedAt: number
    }
  | { type: 'ATTEMPT_CANCELLED'; attemptId: string; reason: string; completedAt: number }
  | {
      type: 'ATTEMPT_SKIPPED'
      attemptId: string
      reason: 'duplicate' | 'policy' | 'budget' | 'scope' | 'profile' | 'unavailable' | 'approval'
      completedAt: number
    }
  | { type: 'STRATEGY_DECISION_RECORDED'; decision: StrategyDecision }
  | {
      type: 'REASONING_FAILED'
      source: 'main-agent' | 'workflow' | 'oneshot' | 'specialist' | 'manual'
      attemptId?: string
      runId?: string
      workflowRunId?: string
      oneShotRunId?: string
      handoffId?: string
      error: { code?: string; message: string }
      at: number
    }
  | { type: 'PENDING_ACTION_ADDED'; pending: PendingSuggestedAction }
  | { type: 'PENDING_ACTION_STATUS_CHANGED'; pendingId: string; status: PendingSuggestedAction['status']; at: number }
  | { type: 'REASONING_BUDGET_CONSUMED'; snapshot: ReasoningBudgetState }
  | { type: 'FLAG_CANDIDATE_DETECTED'; candidate: FlagCandidate }
  | { type: 'FLAG_CANDIDATE_VALIDATED'; candidateId: string; errors: string[] }
  | { type: 'FLAG_CANDIDATE_REJECTED'; candidateId: string; reason: string }

/** A subscriber receives every event AFTER it has been applied. */
export type TaskStateListener = (event: CTFTaskEvent, state: Readonly<CTFTaskState>) => void
export type Unsubscribe = () => void
