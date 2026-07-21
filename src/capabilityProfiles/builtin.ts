/**
 * Built-in CapabilityProfile catalogue — the CTF "specialist" preset set.
 *
 *   - orchestrator  Strategic command: scheduling, handoff approval, NO direct
 *                  execution tools (nmap / curl / RsaCtfTool etc).
 *   - triage        Low-cost image / file / network heuristics, NO deep solving.
 *   - image-stego   PNG/JPEG-only tools. Default workflow: image_quick_scan.
 *   - crypto        crypto-only tools. Default workflow: encoding_sweep,
 *                  rsa_common_attacks.
 *   - file-forensics  archive + magic + entropy. Default: unknown_file_triage,
 *                  archive_recursive_extract.
 *
 * The id of each profile matches the SpecialistAgentFactory convention. Adding
 * a profile is one entry here + register a matching set of tools.
 */

import type { CapabilityProfile } from '../core/capabilityProfile.js'

export const PROFILES: Record<string, CapabilityProfile> = {
  'orchestrator': {
    id: 'orchestrator',
    displayName: 'CTF Orchestrator',
    description:
      '全局指挥 Agent。只负责任务拆分 / 调度 / 接力 / 取消。它不直接执行低级工具。',
    systemPromptModules: ['role.boundary', 'tool.first', 'handoff.protocol', 'artifact.protocol'],
    allowedTools: [
      'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'TodoWrite',
      'load_skill', 'memory_search', 'memory_recall',
      'handoff_request', 'request_specialist', 'cancel_specialist', 'update_priority',
      'list_artifacts', 'list_findings', 'list_jobs',
    ],
    deniedTools: ['Bash', 'Write', 'Edit', 'Agent', 'TmuxSession'],
    allowedWorkflows: [],
    deniedWorkflows: [],
    allowShell: false,
    allowPython: false,
    allowBackgroundJobs: true,
    allowAgentHandoff: true,
    limits: { maxIterations: 50 },
  },
  'triage': {
    id: 'triage',
    displayName: 'Triage Agent',
    description:
      '低成本初筛 Agent:识别输入类型 / 启发性检查 / 路由建议。它不做深度解题。',
    systemPromptModules: ['role.boundary', 'tool.first', 'triage.heuristics'],
    allowedTools: ['Read', 'Glob', 'Grep', 'Bash', 'TodoWrite', 'WebFetch', 'WebSearch',
      'load_skill', 'memory_search', 'memory_recall', 'emit_finding', 'request_handoff'],
    deniedTools: ['Write', 'Edit'],
    allowedWorkflows: ['unknown_file_triage'],
    allowShell: true,
    allowPython: false,
    allowBackgroundJobs: false,
    allowAgentHandoff: true,
    preferredAgentsForHandoff: ['image-stego', 'crypto', 'file-forensics'],
    limits: { maxIterations: 30, maxToolCalls: 80 },
  },
  'image-stego': {
    id: 'image-stego',
    displayName: 'Image Stego Agent',
    description:
      'PNG / JPEG / GIF / BMP 等图片隐写 Agent。仅暴露图片相关工具和工作流。',
    systemPromptModules: ['role.boundary', 'tool.first', 'image.protocol'],
    allowedTools: ['Read', 'Glob', 'Grep', 'Bash', 'TodoWrite',
      'load_skill', 'memory_search', 'memory_recall',
      'emit_finding', 'request_handoff', 'extract_artifact'],
    deniedTools: ['nmap', 'sqlmap', 'gdb', 'tshark'],
    allowedWorkflows: ['image_quick_scan', 'png_stego_sweep', 'jpeg_stego_sweep', 'image_embedded_file_scan'],
    deniedWorkflows: ['host_service_enumeration'],
    allowShell: true,
    allowPython: false,
    allowBackgroundJobs: true,
    allowAgentHandoff: true,
    preferredAgentsForHandoff: ['crypto', 'file-forensics'],
    limits: { maxIterations: 60, maxToolCalls: 200 },
  },
  'crypto': {
    id: 'crypto',
    displayName: 'Crypto Agent',
    description: 'Crypto / encoding 题目 Agent。优先 encoding_sweep / rsa_common_attacks。',
    systemPromptModules: ['role.boundary', 'tool.first', 'crypto.protocol'],
    allowedTools: ['Read', 'Glob', 'Grep', 'Bash', 'TodoWrite',
      'load_skill', 'memory_search', 'memory_recall', 'Python',
      'emit_finding', 'request_handoff', 'extract_artifact'],
    deniedTools: ['nmap', 'tshark'],
    allowedWorkflows: ['encoding_sweep', 'classical_cipher_sweep', 'xor_key_search',
      'rsa_common_attacks', 'hash_identify_and_crack'],
    deniedWorkflows: ['host_service_enumeration'],
    allowShell: true,
    allowPython: true,
    allowBackgroundJobs: true,
    allowAgentHandoff: true,
    preferredAgentsForHandoff: ['file-forensics'],
    limits: { maxIterations: 60, maxToolCalls: 250 },
  },
  'file-forensics': {
    id: 'file-forensics',
    displayName: 'File Forensics Agent',
    description: '文件取证 Agent:压缩包 / 魔数修复 / 嵌套文件 / 元数据。',
    systemPromptModules: ['role.boundary', 'tool.first', 'forensics.protocol'],
    allowedTools: ['Read', 'Glob', 'Grep', 'Bash', 'TodoWrite',
      'load_skill', 'memory_search', 'memory_recall',
      'emit_finding', 'request_handoff', 'extract_artifact'],
    deniedTools: ['nmap', 'tshark', 'sqlmap'],
    allowedWorkflows: ['unknown_file_triage', 'archive_recursive_extract',
      'embedded_content_scan', 'magic_header_repair_candidates'],
    deniedWorkflows: ['host_service_enumeration'],
    allowShell: true,
    allowPython: false,
    allowBackgroundJobs: true,
    allowAgentHandoff: true,
    preferredAgentsForHandoff: ['crypto', 'image-stego'],
    limits: { maxIterations: 60, maxToolCalls: 200 },
  },
}

export function getBuiltinProfile(id: string): CapabilityProfile | undefined {
  return PROFILES[id]
}

export function listBuiltinProfiles(): string[] {
  return [...Object.keys(PROFILES)]
}
