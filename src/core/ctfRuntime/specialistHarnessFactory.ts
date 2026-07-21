/**
 * SpecialistHarnessFactory — the single class that creates a Specialist
 * Harness for a Handoff.
 *
 * Per forth_goal.md §八 it guarantees:
 *   - Client / Renderer / ModelConfig / Profile are inherited from the
 *     parent (never silently nulled).
 *   - The Specialist runs under a NARROWER TaskExecutionContext derived via
 *     `deriveSubtaskContext` — refuse widening at this layer too.
 *   - The Specialist's Profile is its OWN (not the parent's). The parent's
 *     Profile stays unchanged when the Specialist starts.
 *   - The AbortSignal is linked to the parent so cancellation propagates.
 *   - Teardown is explicit via `handle.dispose()`.
 *
 * The factory is the only seam where a Specialist Harness is constructed.
 * Anywhere else that does so is a regression of §八 / §十二.
 */

import type { CapabilityProfile } from '../capabilityProfile.js'
import { createHarness, type HarnessBundle } from '../harness.js'
import type { ContestScope } from '../contestScope.js'
import { parseContestScope } from '../contestScope.js'
import type { ArtifactStore } from '../artifacts.js'
import type { FindingStore } from '../findings.js'

import type { TaskExecutionContext } from './taskExecutionContext.js'
import { deriveSubtaskContext } from './taskExecutionContext.js'
import type { LinkedAbortController } from './linkedAbortController.js'
import type { AgentRuntimeDependencies } from './agentRuntimeDependencies.js'
import type { HandoffRecord } from './taskState.js'

export interface CreateSpecialistHarnessInput {
  parentContext: TaskExecutionContext
  parentTaskId: string
  handoff: HandoffRecord
  /** Profile already resolved by HandoffCoordinator. */
  profile: CapabilityProfile
  /** Shared runtime deps (client/renderer/modelConfig/eventLog). */
  dependencies: AgentRuntimeDependencies
  /** Linked abort controller already bound to the parent's signal. */
  abort: LinkedAbortController
  /** Sub-context overrides — must NARROW the parent's scope. */
  subtaskScope: ContestScope
  /** Sub-task id (e.g. `<parent>/spec_<handoffId.slice(-6)>`). */
  subtaskId: string
  /** Independent sessionDir for the specialist. */
  sessionsRoot?: string
  /** Independent artifactDir for the specialist. */
  artifactDir?: string
  /** Workspace root. */
  cwd: string
  /** Parent's artifact store — shared so the projector observes writes. */
  parentArtifactStore: ArtifactStore
  /** Parent's finding store — shared so the projector observes writes. */
  parentFindingStore: FindingStore
}

export interface SpecialistHarnessHandle {
  harness: HarnessBundle
  context: TaskExecutionContext
  abort: LinkedAbortController
  /** Detach the parent signal listener. Safe to call multiple times. */
  dispose(): Promise<void>
}

export class SpecialistHarnessFactory {
  /**
   * Build a complete Specialist Harness bundle. Returns a rejected Promise
   * when shared deps are missing (the factory refuses to spawn a half-wired
   * harness).
   */
  create(input: CreateSpecialistHarnessInput): Promise<SpecialistHarnessHandle> {
    if (!input.dependencies.client) {
      return Promise.reject(
        new Error(
          'createSpecialistHarness: parent must provide a real OpenAI client; ' +
            'specialists cannot run without one.',
        ),
      )
    }
    if (!input.dependencies.renderer) {
      return Promise.reject(
        new Error(
          'createSpecialistHarness: parent must provide a Renderer; ' +
            'specialists cannot run without one.',
        ),
      )
    }

    // Validate the narrowed scope before deriving the context.
    parseContestScope(input.subtaskScope)

    const subContext = deriveSubtaskContext(input.parentContext, {
      subtaskId: input.subtaskId,
      contestScope: input.subtaskScope,
      workspaceDir: input.cwd,
      artifactDir: input.artifactDir,
      sessionDir: input.sessionsRoot ?? input.parentContext.sessionDir,
      profileId: input.profile.id,
      metadata: { fromHandoff: input.handoff.id },
    })

    // Re-bind the abort signal from the linked controller so the harness
    // carries the child signal (which fires when the parent cancels).
    const linkedContext: TaskExecutionContext = {
      ...subContext,
      abortSignal: input.abort.signal,
    }

    const harness = createHarness({
      cwd: input.cwd,
      profile: input.profile,
      contestScope: linkedContext.contestScope,
      taskId: linkedContext.taskId,
      sessionsRoot: input.sessionsRoot,
      client: input.dependencies.client,
      renderer: input.dependencies.renderer,
      // Share the parent's stores so the orchestrator's projector observes
      // every write the specialist makes — this is what enables the
      // Handoff → Specialist → Parent-state → .lineage.jsonl end-to-end
      // path that forth_goal §十三 requires.
      artifactStore: input.parentArtifactStore,
      findingStore: input.parentFindingStore,
    })
    ;(harness as unknown as { context: TaskExecutionContext }).context = linkedContext

    return Promise.resolve({
      harness,
      context: linkedContext,
      abort: input.abort,
      dispose(): Promise<void> {
        input.abort.unlink()
        return Promise.resolve()
      },
    })
  }
}