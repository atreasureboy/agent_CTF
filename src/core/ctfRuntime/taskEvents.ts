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

/** A subscriber receives every event AFTER it has been applied. */
export type TaskStateListener = (event: CTFTaskEvent, state: Readonly<CTFTaskState>) => void
export type Unsubscribe = () => void
