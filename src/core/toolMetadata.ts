/**
 * Tool metadata catalogue — declarative CTF tags for every legacy Tool.
 *
 * The existing src/tools/* module exports plain Tool classes. Wiring them into
 * the registry requires this metadata side-table. Adding a new tool or
 * changing a tool's role is a one-line edit here.
 *
 * Note: requiredBinaries is intentionally left empty for tools that ship with
 * Node.js. Tools backed by external binaries (zsteg, binwalk, RsaCtfTool, ...)
 * are wired separately by the CTF Workflow layer — those binaries aren't
 * required to be present for the harness to function.
 */

import type { CTFToolMetadata } from './toolDefinition.js'

export const TOOL_METADATA: Record<string, CTFToolMetadata> = {
  Bash: {
    domains: ['shell', 'fs'],
    executionMode: 'either',
    costClass: 'medium',
    outputMode: 'inline',
    riskLevel: 'medium',
  },
  Read: {
    domains: ['fs'],
    executionMode: 'foreground',
    costClass: 'cheap',
    outputMode: 'inline',
    riskLevel: 'low',
  },
  Write: {
    domains: ['fs'],
    executionMode: 'foreground',
    costClass: 'cheap',
    outputMode: 'inline',
    riskLevel: 'medium',
  },
  Edit: {
    domains: ['fs'],
    executionMode: 'foreground',
    costClass: 'cheap',
    outputMode: 'inline',
    riskLevel: 'medium',
  },
  Glob: {
    domains: ['fs'],
    executionMode: 'foreground',
    costClass: 'cheap',
    outputMode: 'inline',
    riskLevel: 'low',
  },
  Grep: {
    domains: ['fs'],
    executionMode: 'foreground',
    costClass: 'cheap',
    outputMode: 'inline',
    riskLevel: 'low',
  },
  TodoWrite: {
    domains: ['meta'],
    executionMode: 'foreground',
    costClass: 'cheap',
    outputMode: 'inline',
    riskLevel: 'low',
  },
  WebFetch: {
    domains: ['web'],
    executionMode: 'foreground',
    costClass: 'cheap',
    outputMode: 'inline',
    riskLevel: 'medium',
  },
  WebSearch: {
    domains: ['web'],
    executionMode: 'foreground',
    costClass: 'medium',
    outputMode: 'inline',
    riskLevel: 'medium',
  },
  Agent: {
    domains: ['agent'],
    executionMode: 'foreground',
    costClass: 'expensive',
    outputMode: 'inline',
    riskLevel: 'high',
  },
  TmuxSession: {
    domains: ['shell'],
    executionMode: 'foreground',
    costClass: 'medium',
    outputMode: 'inline',
    riskLevel: 'medium',
  },
  load_skill: {
    domains: ['meta'],
    executionMode: 'foreground',
    costClass: 'cheap',
    outputMode: 'inline',
    riskLevel: 'low',
  },
  memory_write: {
    domains: ['memory'],
    executionMode: 'foreground',
    costClass: 'cheap',
    outputMode: 'inline',
    riskLevel: 'low',
  },
  memory_search: {
    domains: ['memory'],
    executionMode: 'foreground',
    costClass: 'cheap',
    outputMode: 'inline',
    riskLevel: 'low',
  },
  memory_recall: {
    domains: ['memory'],
    executionMode: 'foreground',
    costClass: 'cheap',
    outputMode: 'inline',
    riskLevel: 'low',
  },
}
