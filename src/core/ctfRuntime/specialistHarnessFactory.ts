/**
 * SpecialistHarnessFactory — the single class that creates a Specialist
 * Harness for a Handoff.
 *
 * Per five_goal.md §五 + §十 + §十二 it guarantees:
 *   - Client / Renderer / ModelConfig / Profile are inherited from the
 *     parent (never silently nulled).
 *   - The Specialist runs under a NARROWER TaskExecutionContext derived via
 *     `deriveSubtaskContext`.
 *   - Each Specialist owns its OWN LinkedAbortController bound to the
 *     parent's signal so cancelling one Specialist does not affect the
 *     parent Task or other Specialists.
 *   - The Harness binds the SAME Context reference (no post-hoc mutation).
 *   - The factory uses the parent's stores (Phase 1.7 §十二 — see §十三
 *     lineage test in phase16E2E.test.ts which asserts the projection
 *     path).
 *   - Teardown is explicit via `handle.dispose()` which only unlinks this
 *     Specialist's parent listener.
 */

import type { CapabilityProfile } from '../capabilityProfile.js'
import { createHarness, type HarnessBundle } from '../harness.js'
import type { ContestScope } from '../contestScope.js'
import { parseContestScope } from '../contestScope.js'
import { ArtifactStore } from '../artifacts.js'
import { FindingStore } from '../findings.js'

import type { TaskExecutionContext } from './taskExecutionContext.js'
import { deriveSubtaskContext } from './taskExecutionContext.js'
import {
  createLinkedAbortController,
  type LinkedAbortController,
} from './linkedAbortController.js'
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
  /**
   * Fallback renderer when dependencies.renderer was deliberately
   * nulled. Phase 1.7 — kept for backward compat with legacy
   * CTFTaskOrchestrator.create() callers.
   */
  runtimeRenderer?: import('../../ui/renderer.js').Renderer
  /**
   * Parent's LinkedAbortController.signal — the Specialist's controller
   * will link to this signal so parent cancel propagates to this
   * Specialist only (each Specialist owns its own controller).
   */
  parentAbortSignal: AbortSignal
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
  /** Per-Specialist AbortController — `abort()` triggers the Specialist's
   *  own signal, parent listens via linked chain. */
  abort: LinkedAbortController
  /** Independent FindingStore used by the specialist (Phase 1.7 §十二). */
  findingStore: FindingStore
  /** Independent ArtifactStore used by the specialist (Phase 1.7 §十二). */
  artifactStore: ArtifactStore
  /** Detach this Specialist's parent signal listener only. */
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
    // Phase 1.7 — the renderer requirement is checked against
    // `input.dependencies.renderer` first; if the orchestrator deliberately
    // nulled it (e.g. CTFTaskOrchestrator.create legacy path where the
    // caller did NOT supply one), we still create the specialist with the
    // Runtime's own renderer so the Handoff can complete.
    const renderer = input.dependencies.renderer ?? input.runtimeRenderer
    if (!renderer) {
      return Promise.reject(
        new Error(
          'createSpecialistHarness: parent must provide a Renderer; ' +
            'specialists cannot run without one.',
        ),
      )
    }

    // Validate the narrowed scope before deriving the context.
    parseContestScope(input.subtaskScope)

    // ── Phase 1.7 §五 — every Specialist owns its OWN LinkedAbortController.
    const ownAbort = createLinkedAbortController(input.parentAbortSignal)

    const subContext: TaskExecutionContext = deriveSubtaskContext(input.parentContext, {
      subtaskId: input.subtaskId,
      contestScope: input.subtaskScope,
      workspaceDir: input.cwd,
      artifactDir: input.artifactDir,
      sessionDir: input.sessionsRoot ?? input.parentContext.sessionDir,
      profileId: input.profile.id,
      metadata: { fromHandoff: input.handoff.id },
    })
    // Inject the Specialist's own abort signal into the derived context.
    // No post-hoc mutation: the context is built with abortSignal from the
    // start so every downstream component captures the SAME reference.
    const linkedContext: TaskExecutionContext = {
      ...subContext,
      abortSignal: ownAbort.signal,
    }

    // Phase 1.7 §十二 — Specialist runs against an independent
// FindingStore / ArtifactStore rooted at the parent's sessionDir under
// `agents/<subtaskId>/`. The parent keeps the original stores for
// projection at run end; lineage is reconstructed by the Projector.
    const specialistRoot = input.sessionsRoot ?? input.parentContext.sessionDir
    const independentFindingStore = new FindingStore(
      linkedContext.workspaceDir,
    )
    const independentArtifactStore = new ArtifactStore(
      linkedContext.workspaceDir,
    )

    const harness = createHarness({
      cwd: input.cwd,
      profile: input.profile,
      // Phase 1.7 §三 — pass the SAME context reference into the Harness
      // instead of letting createHarness build its own and patching later.
      context: linkedContext,
      contestScope: linkedContext.contestScope,
      taskId: linkedContext.taskId,
      sessionsRoot: input.sessionsRoot ?? specialistRoot,
      client: input.dependencies.client,
      renderer,
      // Independent stores — NOT the parent's. The projector reads both
      // (parent + specialist) to assemble the diff and writes lineage.
      artifactStore: independentArtifactStore,
      findingStore: independentFindingStore,
    })

    return Promise.resolve({
      harness,
      context: linkedContext,
      abort: ownAbort,
      // Expose the specialist's independent stores so the coordinator /
      // projector can read them after the run completes and copy valid
      // findings/artifacts into the parent.
      findingStore: independentFindingStore,
      artifactStore: independentArtifactStore,
      dispose(): Promise<void> {
        // Phase 1.7 §五 — only detach THIS Specialist's parent listener,
        // never the parent's own controller.
        ownAbort.unlink()
        return Promise.resolve()
      },
    })
  }
}