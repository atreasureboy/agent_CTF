/**
 * run_one_shot — Phase 2.0 §十一 + §十二.
 *
 * Tool inputs restricted to: manifestId, inputArtifactIds, options, reason.
 * Workspace, evidenceRoot, scope, taskId, profileId are sourced from the
 * runtime-injected `context.taskContext` and CANNOT be overridden by the
 * model.
 *
 * argv is NOT supplied by the model. The framework resolves it from
 * `manifest.input.argumentTemplate` and `inputArtifactIds`. Extra args
 * must pass `manifest.input.optionsSchema` + `allowedExtraArgs`.
 */

import type { Tool, ToolContext, ToolDefinition, ToolResult } from '../../core/types.js'
import type { Dispatcher } from '../oneshot/dispatcher.js'
import type { OneShotRegistry } from '../oneshot/registry.js'
import { resolveArgumentTemplate } from '../oneshot/argumentResolver.js'

export const RUN_ONE_SHOT_DEFINITION: ToolDefinition = {
  type: 'function',
  function: {
    name: 'run_one_shot',
    description:
      'Run a CTF one-shot tool by manifest id. Returns a short summary; raw ' +
      'output is preserved on disk and inspectable via inspect_one_shot_result.',
    parameters: {
      type: 'object',
      properties: {
        manifestId: {
          type: 'string',
          description: 'manifest identifier (e.g. "zsteg", "rsactftool")',
        },
        inputArtifactIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Artifact IDs from the parent task (resolved by the framework to filesystem paths).',
        },
        options: {
          type: 'object',
          description: 'Tool-specific options; validated against manifest.input.optionsSchema.',
          additionalProperties: true,
        },
        reason: {
          type: 'string',
          description: 'Short reason for the run (audit only).',
        },
      },
      required: ['manifestId'],
      additionalProperties: false,
    },
  },
}

export interface RunOneShotToolDeps {
  registry: OneShotRegistry
  dispatcher: Dispatcher
  /**
   * TaskExecutionContext lookup — used to resolve input artifacts to
   * filesystem paths. Supplied by the Runtime, not the model.
   */
  taskContext: import('../../core/ctfRuntime/taskExecutionContext.js').TaskExecutionContext
  /** Artifact ID → filesystem path resolver. */
  resolveArtifactPath?: (artifactId: string) => string | undefined
}

export function makeRunOneShotTool(deps: RunOneShotToolDeps): Tool {
  const { registry, dispatcher, taskContext, resolveArtifactPath } = deps
  return {
    name: 'run_one_shot',
    definition: RUN_ONE_SHOT_DEFINITION,
    concurrencySafe: true,
    async execute(
      input: Record<string, unknown>,
      _context: ToolContext,
    ): Promise<ToolResult> {
      const { manifestId, inputArtifactIds, options, reason } = input as {
        manifestId: string
        inputArtifactIds?: string[]
        options?: Record<string, unknown>
        reason?: string
      }
      if (!manifestId || !registry.has(manifestId)) {
        return { content: `unknown manifestId: ${manifestId}`, isError: true }
      }
      const manifest = registry.get(manifestId)!

      // §十三 — paths must be authorised. We resolve ${artifact:N} placeholders
      // before passing argv to the runner; the resolver checks containment.
      let argv: string[]
      try {
        argv = resolveArgumentTemplate(manifest, {
          artifactIds: inputArtifactIds ?? [],
          options: options ?? {},
          resolveArtifactPath,
          taskWorkspaceDir: taskContext.workspaceDir,
          // §round-2 audit fix — pass the contest boundary.
          allowedFilesRoot: taskContext.contestScope.allowedFilesRoot,
        })
      } catch (err) {
        return {
          content: `run_one_shot rejected: ${(err as Error).message}`,
          isError: true,
        }
      }

      // §十一 — evidenceRoot is owned by the Runtime, never the model.
      const evidenceRoot = `${taskContext.artifactDir}/.oneshots`

      try {
        const result = await dispatcher.runOne(manifestId, {
          argv,
          evidenceRoot,
          resolvedInput: {
            artifactIds: inputArtifactIds,
            options,
          },
          reason,
        })
        return {
          content:
            `${result.summary}\n` +
            `Run ${result.runId} → ${result.status}; ` +
            `findings=${result.findings.length}, candidates=${result.candidates.length}.`,
          isError: result.status === 'failed',
        }
      } catch (err) {
        return { content: `run_one_shot failed: ${(err as Error).message}`, isError: true }
      }
    },
  }
}