/**
 * LinkedAbortController — parent/child AbortController chain.
 *
 * Goals:
 *   - When the parent's signal aborts, the child aborts automatically with
 *     the same reason.
 *   - The child can abort independently (e.g. a specialist that finishes or
 *     fails early) without cancelling the parent — that decision is left to
 *     the orchestrator.
 *   - No leaked event listeners: calling `unlink()` removes the bridge so a
 *     short-lived child controller can be GC'd cleanly.
 *
 * This is the only mechanism by which the orchestrator's AbortSignal reaches
 * Main Agent / Workflow / Tool / Specialist / JobManager.
 */

export interface LinkedAbortController {
  /** The local child controller; abort() fires `signal` to all listeners. */
  controller: AbortController
  /** The child's signal — pass it down into EngineConfig / ToolCtx / etc. */
  signal: AbortSignal
  /** Detach the parent's listener. Safe to call multiple times. */
  unlink(): void
}

/**
 * Create a child AbortController that aborts when `parent` aborts.
 *
 *   const child = createLinkedAbortController(parentSignal)
 *   child.controller.abort('specialist failed')   // child-only
 *   parentSignal.abort('user_cancelled')          // child also aborts
 *
 * Returns a handle with `controller`, `signal`, and `unlink()`. After
 * `unlink()`, the child is detached — cancelling the parent will NOT
 * propagate. Call this in `dispose()` to avoid leaks.
 */
export function createLinkedAbortController(parent?: AbortSignal): LinkedAbortController {
  const controller = new AbortController()

  let parentListener: (() => void) | null = null
  if (parent && !parent.aborted) {
    parentListener = () => {
      try {
        controller.abort(parent.reason ?? 'parent_aborted')
      } catch {
        /* ignore — controller may already be aborted */
      }
    }
    parent.addEventListener('abort', parentListener, { once: true })
  } else if (parent?.aborted) {
    // Parent was already aborted before the child was created — propagate.
    try {
      controller.abort(parent.reason ?? 'parent_aborted')
    } catch {
      /* ignore */
    }
  }

  const unlink = (): void => {
    if (parentListener && parent) {
      try {
        parent.removeEventListener('abort', parentListener)
      } catch {
        /* ignore */
      }
      parentListener = null
    }
  }

  return { controller, signal: controller.signal, unlink }
}