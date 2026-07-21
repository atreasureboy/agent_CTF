/**
 * Built-in Workflow Catalogue — the 4 starter workflows from goal.md §四·7 and
 * the image/crypto/forensics chapters.
 *
 * Each workflow is constructed at module-load time and is fully declarative
 * (no closures). The Engine resolves them against the ToolBroker.
 */

import type { WorkflowDefinition } from '../core/workflowDefinition.js'

export const WORKFLOW_UNKNOWN_FILE_TRIAGE: WorkflowDefinition = {
  id: 'unknown_file_triage',
  name: 'Unknown File Triage',
  description:
    '对未知文件做最小成本初筛,识别文件类型、魔数、熵、关键字,并提交 HandoffRequest 给对应的领域 Agent。',
  domains: ['forensics'],
  acceptedInputs: ['file_path'],
  executionMode: 'sequential',
  partialFailurePolicy: 'continue',
  requiredTools: ['Bash'],
  stopConditions: [],
  steps: [
    {
      kind: 'tool',
      id: 'file',
      toolId: 'Bash',
      input: { command: 'file "$FILE_INPUT"', description: '魔数识别' },
    },
    {
      kind: 'tool',
      id: 'magic',
      toolId: 'Bash',
      input: {
        command: 'xxd "$FILE_INPUT" | head -n 16',
        description: '头 256 字节 hex',
      },
    },
    {
      kind: 'tool',
      id: 'strings',
      toolId: 'Bash',
      input: { command: 'strings -n 6 "$FILE_INPUT" | head -n 50', description: '可读字符串' },
    },
    {
      kind: 'tool',
      id: 'entropy',
      toolId: 'Bash',
      input: {
        command: '(which ent >/dev/null && ent "$FILE_INPUT" | head -n 4) || echo "ent not installed"',
        description: '熵检测(若可用)',
      },
    },
    {
      kind: 'if',
      id: 'zip-followup',
      when: "magic.contains '504b0304'",
      then: [
        {
          kind: 'tool',
          id: 'unzip-list',
          toolId: 'Bash',
          input: {
            command: 'unzip -l "$FILE_INPUT" 2>&1 | head -n 50',
            description: '如果魔数为 ZIP 列出归档内容',
          },
        },
      ],
    },
    {
      kind: 'emit_finding',
      id: 'triage-summary',
      category: 'triage',
      title: 'Triage summary',
      summary: '识别到的文件类型 + 推荐领域 Agent',
      confidence: 'medium',
      suggestedNextActions: ['request_handoff'],
      suggestedAgent: 'image-stego|crypto|file-forensics',
    },
  ],
}

export const WORKFLOW_IMAGE_QUICK_SCAN: WorkflowDefinition = {
  id: 'image_quick_scan',
  name: 'Image Quick Scan',
  description: '图片初筛:低成本→并行扫描→条件 steghide。',
  domains: ['image'],
  acceptedInputs: ['file_path'],
  executionMode: 'sequential',
  partialFailurePolicy: 'continue',
  requiredTools: ['Bash'],
  stopConditions: [],
  steps: [
    // Phase 1 — cheap checks (sequential)
    { kind: 'tool', id: 'phase1-file',     toolId: 'Bash', input: { command: 'file "$FILE_INPUT"' } },
    { kind: 'tool', id: 'phase1-exiftool', toolId: 'Bash', input: { command: 'exiftool "$FILE_INPUT" 2>&1 | head -n 60' } },
    { kind: 'tool', id: 'phase1-identify', toolId: 'Bash', input: { command: 'identify -verbose "$FILE_INPUT" 2>&1 | head -n 60' } },
    { kind: 'tool', id: 'phase1-strings',  toolId: 'Bash', input: { command: 'strings -n 6 "$FILE_INPUT" | head -n 60' } },

    // Phase 2 — parallel scans
    {
      kind: 'parallel',
      id: 'phase2',
      join: 'all',
      steps: [
        { kind: 'tool', id: 'p2-binwalk', toolId: 'Bash', input: { command: 'binwalk -e "$FILE_INPUT" 2>&1 | head -n 50' } },
        { kind: 'tool', id: 'p2-zsteg',   toolId: 'Bash', input: { command: 'zsteg "$FILE_INPUT" 2>&1 | head -n 80 || echo "zsteg not installed"' } },
        { kind: 'tool', id: 'p2-pngcheck',toolId: 'Bash', input: { command: 'pngcheck -v "$FILE_INPUT" || true' } },
      ],
    },

    {
      kind: 'emit_finding',
      id: 'image-summary',
      category: 'image',
      title: 'Image quick scan summary',
      summary: 'exiftool + binwalk + zsteg + pngcheck 简要汇总',
      confidence: 'medium',
      suggestedNextActions: ['request_handoff'],
      suggestedAgent: 'crypto|file-forensics',
    },
  ],
}

export const WORKFLOW_ENCODING_SWEEP: WorkflowDefinition = {
  id: 'encoding_sweep',
  name: 'Encoding Sweep',
  description: '尝试常见编码解码,挑选出可读结果。',
  domains: ['crypto'],
  acceptedInputs: ['input_string'],
  executionMode: 'parallel',
  partialFailurePolicy: 'continue',
  requiredTools: ['Bash'],
  stopConditions: [],
  steps: [
    {
      kind: 'parallel',
      id: 'parallel-decode',
      join: 'all',
      steps: [
        { kind: 'tool', id: 'b16', toolId: 'Bash', input: { command: 'printf %s "$TEXT_INPUT" | base16 -d 2>/dev/null || true' } },
        { kind: 'tool', id: 'b32', toolId: 'Bash', input: { command: 'printf %s "$TEXT_INPUT" | base32 -d 2>/dev/null || true' } },
        { kind: 'tool', id: 'b64', toolId: 'Bash', input: { command: 'printf %s "$TEXT_INPUT" | base64 -d 2>/dev/null || true' } },
        { kind: 'tool', id: 'b85', toolId: 'Bash', input: { command: 'printf %s "$TEXT_INPUT" | base85 -d 2>/dev/null || true' } },
        { kind: 'tool', id: 'rot13', toolId: 'Bash', input: { command: 'printf %s "$TEXT_INPUT" | tr "A-Za-z" "N-ZA-Mn-za-m" || true' } },
        { kind: 'tool', id: 'url', toolId: 'Bash', input: { command: 'python3 -c "import urllib.parse,sys;print(urllib.parse.unquote(sys.argv[1]))" "$TEXT_INPUT" || true' } },
      ],
    },
    {
      kind: 'emit_finding',
      id: 'encoding-summary',
      category: 'crypto',
      title: 'Encoding sweep',
      summary: '所有命中解码的简要结果',
      confidence: 'medium',
    },
  ],
}

export const WORKFLOW_RSA_COMMON_ATTACKS: WorkflowDefinition = {
  id: 'rsa_common_attacks',
  name: 'RSA Common Attacks Skeleton',
  description:
    'RSA 参数已知时,依次尝试因子库 / Fermat / Wiener / Yafu / SageMath 公共攻击。失败则放手写。',
  domains: ['crypto'],
  acceptedInputs: ['n', 'e', 'c'],
  executionMode: 'sequential',
  partialFailurePolicy: 'continue',
  requiredTools: ['Bash'],
  stopConditions: [],
  steps: [
    { kind: 'tool', id: 'check-bins', toolId: 'Bash', input: { command: 'which RsaCtfTool yafu openssl sage 2>&1 | head -n 20' } },
    { kind: 'tool', id: 'rsactf',     toolId: 'Bash', input: { command: 'echo "Run RsaCtfTool with --publickey {n,e} --uncipherfile c --attack all" | head -n 1' } },
    { kind: 'tool', id: 'wiener',     toolId: 'Bash', input: { command: 'python3 -c "print(\"wiener: e=$(echo $E)\")"' } },
    { kind: 'emit_finding', id: 'rsa-summary', category: 'crypto', title: 'RSA common attacks', summary: '命中 / 失败 列表', confidence: 'low' },
  ],
}

export const BUILTIN_WORKFLOWS: WorkflowDefinition[] = [
  WORKFLOW_UNKNOWN_FILE_TRIAGE,
  WORKFLOW_IMAGE_QUICK_SCAN,
  WORKFLOW_ENCODING_SWEEP,
  WORKFLOW_RSA_COMMON_ATTACKS,
]
