/**
 * Meta Tools — bridge between the LLM and the CTF Harness stores.
 *
 * These are the "first-class" tools the specialist Agents call to:
 *   - emit_finding             : write a structured observation
 *   - request_handoff          : submit HandoffRequest to the Orchestrator
 *   - inspect_finding           : look up a finding by id
 *   - inspect_artifact_summary : peek at an artifact without reading full content
 *   - extract_artifact         : persist a current extraction as an artifact
 *   - list_artifacts / list_findings / list_jobs : browse state
 *   - query_background_job     : poll a running job
 *   - collect_background_result: get the result of a finished job
 *
 * Each tool receives an optional "service handle" via the legacy ToolContext
 * (we extend the context through the Broker). When invoked without a handle
 * (e.g. during a one-off test), they degrade gracefully.
 */

import type {
  Tool,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '../core/types.js'
import type { ArtifactStore } from '../core/artifacts.js'
import type { FindingStore } from '../core/findings.js'
import type { HandoffStore } from '../core/handoff.js'
import type { BackgroundJobManager } from '../core/backgroundJobs.js'
import type {
  FindingCategory,
  FindingConfidence,
} from '../core/findings.js'
import { formatFindingForPrompt } from '../core/findings.js'
import type { ArtifactMeta } from '../core/artifacts.js'
import { TOOL_METADATA } from '../core/toolMetadata.js'
import type { CTFToolMetadata, RegisteredTool } from '../core/toolDefinition.js'

/**
 * Service handle exposed through ToolContext — every meta tool resolves to
 * the same instance, but each only reads/writes its slice.
 */
export interface CTFMetaServices {
  taskId: string
  agentId: string
  artifactStore?: ArtifactStore
  findingStore?: FindingStore
  handoffStore?: HandoffStore
  jobManager?: BackgroundJobManager
}

/** Pull services from the legacy ToolContext (the broker pokes them in). */
function resolveServices(context: ToolContext): CTFMetaServices {
  const ext = context as unknown as { __ctf?: CTFMetaServices }
  if (ext.__ctf) return ext.__ctf
  // Fallback — empty services so the tool reports a structured error rather than crashing.
  return {
    taskId: 'unknown',
    agentId: 'unknown',
  }
}

function missingService(service: string): ToolResult {
  return {
    isError: true,
    content: `Meta tool requires the "${service}" service which was not initialised for this run. The CTF Harness must wire ToolContext.__ctf before invoking meta tools.`,
  }
}

function makeMetaTool(
  name: string,
  description: string,
  parameters: unknown,
  handler: (input: Record<string, unknown>, services: CTFMetaServices) => Promise<ToolResult> | ToolResult,
  metadata: CTFToolMetadata,
): Tool {
  return {
    name,
    definition: {
      type: 'function',
      function: { name, description, parameters },
    } as ToolDefinition,
    execute: async (input, context) => handler(input, resolveServices(context)),
    concurrencySafe: true,
  }
}

// ─── emit_finding ──────────────────────────────────────────────────────

export function makeEmitFindingTool(): Tool {
  const t = makeMetaTool(
    'emit_finding',
    '写一条结构化 Finding;由当前 Agent 产出,记录 category/title/summary/confidence/evidence/artifactIds。Task 下所有 Finding 合并后送给 Orchestrator。',
    {
      type: 'object',
      properties: {
        category: { type: 'string', enum: ['triage','forensics','image','crypto','web','reverse','pwn','network','workflow','obfuscation','handoff','verifier'] },
        title: { type: 'string', description: '一句话标题' },
        summary: { type: 'string', description: '完整描述' },
        confidence: { type: 'string', enum: ['low','medium','high'], default: 'medium' },
        evidence: { type: 'array', items: { type: 'string' }, description: '证据条目(命令、文件路径、行号等)' },
        artifactIds: { type: 'array', items: { type: 'string' } },
        recommendedNextActions: { type: 'array', items: { type: 'string' } },
        suggestedAgent: { type: 'string' },
      },
      required: ['category','title','summary'],
    },
    (input, svc) => {
      if (!svc.findingStore) return missingService('findingStore')
      const f = svc.findingStore.append({
        taskId: svc.taskId,
        producerAgentId: svc.agentId,
        category: (input.category ?? 'triage') as FindingCategory,
        title: String(input.title ?? ''),
        summary: String(input.summary ?? ''),
        confidence: (input.confidence ?? 'medium') as FindingConfidence,
        evidence: Array.isArray(input.evidence) ? input.evidence.filter((v): v is string => typeof v === 'string') : [],
        artifactIds: Array.isArray(input.artifactIds) ? input.artifactIds.filter((v): v is string => typeof v === 'string') : [],
        recommendedNextActions: Array.isArray(input.recommendedNextActions) ? input.recommendedNextActions.filter((v): v is string => typeof v === 'string') : undefined,
        suggestedAgent: typeof input.suggestedAgent === 'string' ? input.suggestedAgent : undefined,
      })
      return {
        isError: false,
        content: `Finding stored (id=${f.id}, ${f.category}, ${f.confidence}).\n${formatFindingForPrompt(f)}`,
      }
    },
    {
      domains: ['meta','workflow','forensics'],
      executionMode: 'foreground',
      costClass: 'cheap',
      outputMode: 'inline',
      riskLevel: 'low',
    },
  )
  return t
}

TOOL_METADATA['emit_finding'] = {
  domains: ['meta','workflow','forensics'],
  executionMode: 'foreground',
  costClass: 'cheap',
  outputMode: 'inline',
  riskLevel: 'low',
}

// ─── request_handoff ─────────────────────────────────────────────────────

export function makeRequestHandoffTool(): Tool {
  const t = makeMetaTool(
    'request_handoff',
    '向 Orchestrator 提交 HandoffRequest;传递 artifactIds/findingIds 给接班 Agent。Orchestrator 决策后 instantiate 接班 Agent 并把 Findings/Artifacts 注入其上下文。',
    {
      type: 'object',
      properties: {
        suggestedAgent: { type: 'string', description: '接班 Agent profile id(例如 file-forensics / crypto / image-stego / web)' },
        reason: { type: 'string', description: '为什么需要接力' },
        objective: { type: 'string', description: '接班 Agent 的明确目标' },
        artifactIds: { type: 'array', items: { type: 'string' } },
        findingIds: { type: 'array', items: { type: 'string' } },
        constraints: { type: 'array', items: { type: 'string' } },
        priority: { type: 'number' },
      },
      required: ['suggestedAgent','reason','objective'],
    },
    (input, svc) => {
      if (!svc.handoffStore) return missingService('handoffStore')
      const req = svc.handoffStore.submit({
        taskId: svc.taskId,
        fromAgent: svc.agentId,
        suggestedAgent: String(input.suggestedAgent ?? ''),
        reason: String(input.reason ?? ''),
        objective: String(input.objective ?? ''),
        artifactIds: Array.isArray(input.artifactIds) ? input.artifactIds.filter((v): v is string => typeof v === 'string') : undefined,
        findingIds: Array.isArray(input.findingIds) ? input.findingIds.filter((v): v is string => typeof v === 'string') : undefined,
        constraints: Array.isArray(input.constraints) ? input.constraints.filter((v): v is string => typeof v === 'string') : undefined,
        priority: typeof input.priority === 'number' ? input.priority : undefined,
      })
      return {
        isError: false,
        content: `Handoff submitted (id=${req.id}, status=${req.status}). Orchestrator will review on its next turn.`,
      }
    },
    {
      domains: ['meta','workflow','forensics'],
      executionMode: 'foreground',
      costClass: 'cheap',
      outputMode: 'inline',
      riskLevel: 'low',
    },
  )
  return t
}

TOOL_METADATA['request_handoff'] = {
  domains: ['meta','workflow','forensics'],
  executionMode: 'foreground',
  costClass: 'cheap',
  outputMode: 'inline',
  riskLevel: 'low',
}

// ─── list_artifacts / list_findings / list_jobs ──────────────────────────

function listArtifactsTool(): Tool {
  return makeMetaTool(
    'list_artifacts',
    '列出当前任务的所有 Artifact。返回 id / type / size / path / 摘要。',
    {
      type: 'object',
      properties: {
        type: { type: 'string', description: '按 type 过滤' },
        limit: { type: 'number' },
      },
    },
    (input, svc) => {
      if (!svc.artifactStore) return missingService('artifactStore')
      let all = svc.artifactStore.list()
      const type = typeof input.type === 'string' ? input.type : undefined
      if (type) all = all.filter((a) => a.type === type)
      const limit = typeof input.limit === 'number' ? input.limit : all.length
      all = all.slice(0, limit)
      if (all.length === 0) return { isError: false, content: 'No artifacts.' }
      const lines = all.map((a) => `- ${a.id}  type=${a.type}  size=${a.size}B  path=${a.path}\n  ${a.summary.slice(0, 200)}`)
      return { isError: false, content: lines.join('\n') }
    },
    { domains: ['meta','workflow'], executionMode: 'foreground', costClass: 'cheap', outputMode: 'inline', riskLevel: 'low' },
  )
}

TOOL_METADATA['list_artifacts'] = {
  domains: ['meta','workflow'],
  executionMode: 'foreground',
  costClass: 'cheap',
  outputMode: 'inline',
  riskLevel: 'low',
}

function listFindingsTool(): Tool {
  return makeMetaTool(
    'list_findings',
    '列出当前任务的 Finding。',
    {
      type: 'object',
      properties: {
        category: { type: 'string' },
        confidence: { type: 'string', enum: ['low','medium','high'] },
        limit: { type: 'number' },
      },
    },
    (input, svc) => {
      if (!svc.findingStore) return missingService('findingStore')
      let all = svc.findingStore.list()
      if (typeof input.category === 'string') all = all.filter((f) => f.category === input.category)
      if (typeof input.confidence === 'string') all = all.filter((f) => f.confidence === input.confidence)
      const limit = typeof input.limit === 'number' ? input.limit : all.length
      all = all.slice(0, limit)
      if (all.length === 0) return { isError: false, content: 'No findings.' }
      return { isError: false, content: all.map(formatFindingForPrompt).join('\n\n---\n\n') }
    },
    { domains: ['meta','workflow'], executionMode: 'foreground', costClass: 'cheap', outputMode: 'inline', riskLevel: 'low' },
  )
}

TOOL_METADATA['list_findings'] = {
  domains: ['meta','workflow'],
  executionMode: 'foreground',
  costClass: 'cheap',
  outputMode: 'inline',
  riskLevel: 'low',
}

function listJobsTool(): Tool {
  return makeMetaTool(
    'list_jobs',
    '列出后台任务及其状态。',
    { type: 'object', properties: { status: { type: 'string' } } },
    (input, svc) => {
      if (!svc.jobManager) return missingService('jobManager')
      const filter = (j: { status: string }) =>
        typeof input.status !== 'string' || j.status === input.status
      const all = svc.jobManager.list(filter)
      if (all.length === 0) return { isError: false, content: 'No jobs.' }
      const lines = all.map((j) =>
        `- ${j.id}  ${j.toolId}  ${j.status}  agent=${j.agentId}  elapsed=${j.endedAt ? Date.parse(j.endedAt) - Date.parse(j.startedAt) : '∞'}ms`,
      )
      return { isError: false, content: lines.join('\n') }
    },
    { domains: ['meta','workflow'], executionMode: 'foreground', costClass: 'cheap', outputMode: 'inline', riskLevel: 'low' },
  )
}

TOOL_METADATA['list_jobs'] = {
  domains: ['meta','workflow'],
  executionMode: 'foreground',
  costClass: 'cheap',
  outputMode: 'inline',
  riskLevel: 'low',
}

// ─── query_background_job / collect_background_result ─────────────────────

function queryBackgroundJobTool(): Tool {
  return makeMetaTool(
    'query_background_job',
    '查询后台任务当前状态。',
    {
      type: 'object',
      properties: { jobId: { type: 'string' } },
      required: ['jobId'],
    },
    (input, svc) => {
      if (!svc.jobManager) return missingService('jobManager')
      const jobId = String(input.jobId ?? '')
      const job = svc.jobManager.status(jobId)
      if (!job) return { isError: true, content: `Job not found: ${jobId}` }
      return { isError: false, content: JSON.stringify(job, null, 2) }
    },
    { domains: ['meta','workflow'], executionMode: 'foreground', costClass: 'cheap', outputMode: 'inline', riskLevel: 'low' },
  )
}

TOOL_METADATA['query_background_job'] = {
  domains: ['meta','workflow'],
  executionMode: 'foreground',
  costClass: 'cheap',
  outputMode: 'inline',
  riskLevel: 'low',
}

function collectBackgroundResultTool(): Tool {
  return makeMetaTool(
    'collect_background_result',
    '收集已完成的后台任务结果(短摘要 + 状态)。如未完成,返回当前状态。',
    {
      type: 'object',
      properties: { jobId: { type: 'string' } },
      required: ['jobId'],
    },
    async (input, svc) => {
      if (!svc.jobManager) return missingService('jobManager')
      const jobId = String(input.jobId ?? '')
      const job = svc.jobManager.status(jobId)
      if (!job) return { isError: true, content: `Job not found: ${jobId}` }
      if (job.status === 'running' || job.status === 'pending') {
        return { isError: false, content: `Job ${jobId} is ${job.status}; wait or cancel.` }
      }
      return {
        isError: job.status === 'failed' || job.status === 'cancelled',
        content:
          `Job ${jobId} (${job.toolId}) ${job.status}\n` +
          `summary: ${job.summary ?? '(none)'}\n` +
          `artifactId: ${job.artifactId ?? '(none)'}\n` +
          (job.error ? `error: ${job.error}\n` : '') +
          (job.cancelReason ? `cancelReason: ${job.cancelReason}\n` : ''),
      }
    },
    { domains: ['meta','workflow'], executionMode: 'foreground', costClass: 'cheap', outputMode: 'inline', riskLevel: 'low' },
  )
}

TOOL_METADATA['collect_background_result'] = {
  domains: ['meta','workflow'],
  executionMode: 'foreground',
  costClass: 'cheap',
  outputMode: 'inline',
  riskLevel: 'low',
}

// ─── inspect_artifact_summary / inspect_finding ─────────────────────────

function inspectArtifactSummaryTool(): Tool {
  return makeMetaTool(
    'inspect_artifact_summary',
    '查看 Artifact 的 head+tail 摘要(不读全文)。',
    {
      type: 'object',
      properties: { artifactId: { type: 'string' } },
      required: ['artifactId'],
    },
    (input, svc) => {
      if (!svc.artifactStore) return missingService('artifactStore')
      const id = String(input.artifactId ?? '')
      const meta = svc.artifactStore.read(id)
      if (!meta) return { isError: true, content: `Artifact not found: ${id}` }
      return {
        isError: false,
        content:
          `Artifact ${meta.id}\ntype=${meta.type}  size=${meta.size}B  sha256=${meta.sha256}\npath=${meta.path}\n---\n${meta.summary}`,
      }
    },
    { domains: ['meta','workflow'], executionMode: 'foreground', costClass: 'cheap', outputMode: 'inline', riskLevel: 'low' },
  )
}

TOOL_METADATA['inspect_artifact_summary'] = {
  domains: ['meta','workflow'],
  executionMode: 'foreground',
  costClass: 'cheap',
  outputMode: 'inline',
  riskLevel: 'low',
}

function inspectFindingTool(): Tool {
  return makeMetaTool(
    'inspect_finding',
    '按 id 查找 Finding 详情。',
    {
      type: 'object',
      properties: { findingId: { type: 'string' } },
      required: ['findingId'],
    },
    (input, svc) => {
      if (!svc.findingStore) return missingService('findingStore')
      const id = String(input.findingId ?? '')
      const all = svc.findingStore.list((f) => f.id === id)
      if (all.length === 0) return { isError: true, content: `Finding not found: ${id}` }
      return { isError: false, content: formatFindingForPrompt(all[0]) }
    },
    { domains: ['meta','workflow'], executionMode: 'foreground', costClass: 'cheap', outputMode: 'inline', riskLevel: 'low' },
  )
}

TOOL_METADATA['inspect_finding'] = {
  domains: ['meta','workflow'],
  executionMode: 'foreground',
  costClass: 'cheap',
  outputMode: 'inline',
  riskLevel: 'low',
}

// ─── extract_artifact ──────────────────────────────────────────────────

function extractArtifactTool(): Tool {
  return makeMetaTool(
    'extract_artifact',
    '把当前工具的输出提取(写入)为 Artifact,记录 path 与 id。content 通常来自上一个 Bash/python 输出。',
    {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'Artifact type(例 binwalk-extract / extracted-zip)' },
        path: { type: 'string', description: '提取出来的文件绝对路径' },
        mimeType: { type: 'string' },
      },
      required: ['type','path'],
    },
    async (input, svc) => {
      if (!svc.artifactStore) return missingService('artifactStore')
      const fs = await import('fs/promises')
      const meta: ArtifactMeta | null = await (async () => {
        try {
          const buf = await fs.readFile(String(input.path ?? ''))
          return svc.artifactStore!.writeSync(
            {
              taskId: svc.taskId,
              producerAgentId: svc.agentId,
              type: String(input.type),
              mimeType: typeof input.mimeType === 'string' ? input.mimeType : undefined,
              source: { toolId: 'extract_artifact', inputSummary: String(input.path) },
            },
            buf,
            String(input.type).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 32) || 'bin',
          )
        } catch (err) {
          return null
        }
      })()
      if (!meta) return { isError: true, content: `Failed to read or record ${input.path}` }
      return {
        isError: false,
        content: `Artifact ${meta.id} (${meta.size}B, sha256=${meta.sha256}) recorded at ${meta.path}.`,
      }
    },
    { domains: ['meta','workflow','forensics'], executionMode: 'foreground', costClass: 'cheap', outputMode: 'inline', riskLevel: 'low' },
  )
}

TOOL_METADATA['extract_artifact'] = {
  domains: ['meta','workflow','forensics'],
  executionMode: 'foreground',
  costClass: 'cheap',
  outputMode: 'inline',
  riskLevel: 'low',
}

// ─── Factory ────────────────────────────────────────────────────────────

export function makeAllMetaTools(): Tool[] {
  return [
    makeEmitFindingTool(),
    makeRequestHandoffTool(),
    listArtifactsTool(),
    listFindingsTool(),
    listJobsTool(),
    queryBackgroundJobTool(),
    collectBackgroundResultTool(),
    inspectArtifactSummaryTool(),
    inspectFindingTool(),
    extractArtifactTool(),
  ]
}
