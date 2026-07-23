/**
 * run_one_shot — kick off a single one-shot by id, with explicit argv.
 *
 * The tool's behaviour:
 *   1. Resolve manifestId against the registry; refuse unknown ids.
 *   2. Route scope-required manifests through ScopeGate.
 *   3. Delegate to Dispatcher.runOne() and return the structured summary.
 *
 * The tool returns a SHORT string suitable for LLM context — raw output
 * stays on disk.
 */

import type { Tool, ToolContext, ToolDefinition, ToolResult } from '../../core/types.js'
import type { Dispatcher } from '../oneshot/dispatcher.js'
import type { OneShotRegistry } from '../oneshot/registry.js'
import { ScopeGate, ScopeDeniedError } from '../oneshot/scopeGate.js'

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
        manifestId: { type: 'string', description: 'manifest identifier (e.g. "zsteg", "rsactftool")' },
        argv: {
          type: 'array',
          items: { type: 'string' },
          description: 'arguments appended to manifest.command (e.g. ["/work/INPUT"])',
        },
        workspace: { type: 'string', description: 'task workspace dir' },
        evidenceRoot: { type: 'string', description: 'where to write evidence' },
        scope: {
          type: 'object',
          properties: {
            hosts: { type: 'array', items: { type: 'string' } },
            domains: { type: 'array', items: { type: 'string' } },
            ports: { type: 'array', items: { type: 'number' } },
            cidrs: { type: 'array', items: { type: 'string' } },
          },
        },
      },
      required: ['manifestId', 'argv', 'workspace'],
    },
  },
}

export function makeRunOneShotTool(
  registry: OneShotRegistry,
  dispatcher: Dispatcher,
): Tool {
  return {
    name: 'run_one_shot',
    definition: RUN_ONE_SHOT_DEFINITION,
    concurrencySafe: true,
    async execute(
      input: Record<string, unknown>,
      context: ToolContext,
    ): Promise<ToolResult> {
      const { manifestId, argv, workspace, evidenceRoot, scope } = input as {
        manifestId: string
        argv: string[]
        workspace: string
        evidenceRoot?: string
        scope?: { hosts?: string[]; domains?: string[]; ports?: number[]; cidrs?: string[] }
      }
      if (!manifestId || !registry.has(manifestId)) {
        return { content: `unknown manifestId: ${manifestId}`, isError: true }
      }
      const manifest = registry.get(manifestId)!
      if (manifest.network.mode !== 'none' && !scope) {
        return {
          content: `${manifestId} requires scope (mode=${manifest.network.mode})`,
          isError: true,
        }
      }
      if (scope) {
        const gate = new ScopeGate({
          hosts: scope.hosts ?? [],
          domains: scope.domains ?? [],
          ports: scope.ports ?? [],
          cidrs: scope.cidrs ?? [],
        }, { denyByDefault: true })
        const last = argv.slice(-1)[0]
        if (last) {
          try {
            gate.assert(last)
          } catch (err) {
            if (err instanceof ScopeDeniedError) {
              return { content: `scope denied for ${last}: ${err.reason}`, isError: true }
            }
            throw err
          }
        }
      }
      try {
        const result = await dispatcher.runOne(manifestId, {
          argv,
          evidenceRoot: evidenceRoot ?? `${workspace}/.oneshots`,
          signal: (context as { signal?: AbortSignal }).signal ?? new AbortController().signal,
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
