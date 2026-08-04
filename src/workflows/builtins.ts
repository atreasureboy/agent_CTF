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
        command:
          '(which ent >/dev/null && ent "$FILE_INPUT" | head -n 4) || echo "ent not installed"',
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
    { kind: 'tool', id: 'phase1-file', toolId: 'Bash', input: { command: 'file "$FILE_INPUT"' } },
    {
      kind: 'tool',
      id: 'phase1-exiftool',
      toolId: 'Bash',
      input: { command: 'exiftool "$FILE_INPUT" 2>&1 | head -n 60' },
    },
    {
      kind: 'tool',
      id: 'phase1-identify',
      toolId: 'Bash',
      input: { command: 'identify -verbose "$FILE_INPUT" 2>&1 | head -n 60' },
    },
    {
      kind: 'tool',
      id: 'phase1-strings',
      toolId: 'Bash',
      input: { command: 'strings -n 6 "$FILE_INPUT" | head -n 60' },
    },

    // Phase 2 — parallel scans
    {
      kind: 'parallel',
      id: 'phase2',
      join: 'all',
      steps: [
        {
          kind: 'tool',
          id: 'p2-binwalk',
          toolId: 'Bash',
          input: { command: 'binwalk -e "$FILE_INPUT" 2>&1 | head -n 50' },
        },
        {
          kind: 'tool',
          id: 'p2-zsteg',
          toolId: 'Bash',
          input: { command: 'zsteg "$FILE_INPUT" 2>&1 | head -n 80 || echo "zsteg not installed"' },
        },
        {
          kind: 'tool',
          id: 'p2-pngcheck',
          toolId: 'Bash',
          input: { command: 'pngcheck -v "$FILE_INPUT" || true' },
        },
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
  requiredTools: ['decode_tree'],
  stopConditions: [],
  // §13 R1 fix — the previous 6-step bash only tried single-layer codecs
  // (base16/32/64/85/rot13/url) which can't solve multi-layer encoded
  // challenges like encoding1 (3× base64). Replaced with a single
  // `decode_tree` tool call that recursively walks the codec chain up to
  // maxDepth=4 with flag regex detection. The Bash steps are still kept
  // in active history but are no longer the success path.
  steps: [
    {
      kind: 'tool',
      id: 'decode-tree',
      toolId: 'decode_tree',
      input: {
        text: { ref: '$TEXT_INPUT' },
        flagPattern: 'flag\\{[^}]+\\}',
        maxDepth: 4,
      },
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
    {
      kind: 'tool',
      id: 'check-bins',
      toolId: 'Bash',
      input: { command: 'which RsaCtfTool yafu openssl sage 2>&1 | head -n 20' },
    },
    {
      kind: 'tool',
      id: 'rsactf',
      toolId: 'Bash',
      input: {
        command:
          'echo "Run RsaCtfTool with --publickey {n,e} --uncipherfile c --attack all" | head -n 1',
      },
    },
    {
      kind: 'tool',
      id: 'wiener',
      toolId: 'Bash',
      // eslint-disable-next-line
      input: { command: 'python3 -c "print(\"wiener: e=$(echo $E)\")"' },
    },
    {
      kind: 'emit_finding',
      id: 'rsa-summary',
      category: 'crypto',
      title: 'RSA common attacks',
      summary: '命中 / 失败 列表',
      confidence: 'low',
    },
  ],
}

/**
 * §13 R4 — workflow that calls the xor_known_plaintext tool to recover
 * a repeating XOR key from a known plaintext / ciphertext pair, then
 * decrypt the longer ciphertext. Solves the `xor_known` challenge
 * end-to-end without LLM reasoning.
 *
 * Inputs:
 *   - $KNOWN_PLAINTEXT (utf-8 string passed via --text)
 *   - $KNOWN_CIPHERTEXT_HEX (hex string passed via --text key)
 *   - $TEXT_INPUT (the longer ciphertext, hex)
 */
export const WORKFLOW_XOR_KNOWN_ATTACK: WorkflowDefinition = {
  id: 'xor_known_attack',
  name: 'XOR Known-Plaintext Attack',
  description:
    '已知明文 + 密文 → 推导 XOR key → 解密长密文（适用于 xor_known 等）。',
  domains: ['crypto'],
  acceptedInputs: ['TEXT_INPUT', 'KNOWN_PLAINTEXT', 'KNOWN_CIPHERTEXT_HEX'],
  executionMode: 'sequential',
  partialFailurePolicy: 'abort',
  requiredTools: ['xor_known_plaintext'],
  stopConditions: [],
  steps: [
    {
      kind: 'tool',
      id: 'xor-attack',
      toolId: 'xor_known_plaintext',
      input: {
        cipherHex: { ref: '$TEXT_INPUT' },
        knownPlaintext: { ref: '$KNOWN_PLAINTEXT' },
        knownCiphertextHex: { ref: '$KNOWN_CIPHERTEXT_HEX' },
      },
    },
    {
      kind: 'emit_finding',
      id: 'xor-summary',
      category: 'crypto',
      title: 'XOR known-plaintext attack',
      // Placeholder summary — the broker's auto-emit-flag side effect
      // surfaces the actual flag alongside this finding.
      summary: 'xor_known_plaintext result',
      confidence: 'high',
    },
  ],
}

/**
 * §13 R4 — AES-ECB decryption with known key. Solves the `aes_zero_iv`
 * challenge end-to-end (the challenge is actually AES-ECB despite the
 * title; AES-CBC with zero IV would not have produced the same
 * printable flag for an AES-128 key with no padding).
 *
 * Inputs:
 *   - $KEY_HEX (passed via --text key=value syntax)
 *   - $TEXT_INPUT (the ciphertext hex)
 */
export const WORKFLOW_AES_ECB_ATTACK: WorkflowDefinition = {
  id: 'aes_ecb_attack',
  name: 'AES-ECB Decryption',
  description: '已知 key 时 AES-128/192/256-ECB 解密（aes_zero_iv 等）。',
  domains: ['crypto'],
  acceptedInputs: ['TEXT_INPUT', 'KEY_HEX'],
  executionMode: 'sequential',
  partialFailurePolicy: 'abort',
  requiredTools: ['aes_ecb_decrypt'],
  stopConditions: [],
  steps: [
    {
      kind: 'tool',
      id: 'aes-decrypt',
      toolId: 'aes_ecb_decrypt',
      input: {
        ciphertextHex: { ref: '$TEXT_INPUT' },
        keyHex: { ref: '$KEY_HEX' },
      },
    },
    {
      kind: 'emit_finding',
      id: 'aes-summary',
      category: 'crypto',
      title: 'AES-ECB decryption',
      summary: 'aes_ecb_decrypt result',
      confidence: 'high',
    },
  ],
}

export const WORKFLOW_BINARY_TRIAGE: WorkflowDefinition = {
  id: 'binary_triage',
  name: 'Binary Triage',
  description:
    '二进制逆向初筛:file → strings → nm → objdump → r2 aaa;afl。结构化识别入口函数和可疑符号。',
  domains: ['reverse'],
  acceptedInputs: ['file_path'],
  executionMode: 'sequential',
  partialFailurePolicy: 'continue',
  requiredTools: ['Bash'],
  stopConditions: [],
  steps: [
    { kind: 'tool', id: 'b-file', toolId: 'Bash', input: { command: 'file "$FILE_INPUT"' } },
    {
      kind: 'tool',
      id: 'b-strings',
      toolId: 'Bash',
      input: { command: 'strings -n 6 "$FILE_INPUT" | head -n 100' },
    },
    {
      kind: 'tool',
      id: 'b-nm',
      toolId: 'Bash',
      input: { command: 'nm -C "$FILE_INPUT" 2>&1 | head -n 100' },
    },
    {
      kind: 'tool',
      id: 'b-objdump',
      toolId: 'Bash',
      input: {
        command:
          'objdump -d -M intel "$FILE_INPUT" 2>&1 | head -n 200 || echo "objdump failed (stripped?)"',
      },
    },
    {
      kind: 'tool',
      id: 'b-r2',
      toolId: 'Bash',
      input: {
        command: 'r2 -q -c "aaa;afl" "$FILE_INPUT" 2>&1 | head -n 80 || echo "r2 unavailable"',
      },
    },
    {
      kind: 'emit_finding',
      id: 'b-summary',
      category: 'reverse',
      title: 'Binary triage',
      summary: '类型 + 关键函数 + 入口地址',
      confidence: 'medium',
      suggestedNextActions: ['request_handoff'],
      suggestedAgent: 'pwn|crypto',
    },
  ],
}

export const WORKFLOW_PWN_TRIAGE: WorkflowDefinition = {
  id: 'pwn_triage',
  name: 'Pwn Triage',
  description:
    '漏洞利用初筛:checksec → file → strings → 运行观察 → gdb -batch 调试。结构化捕获寄存器/段表/栈状态。',
  domains: ['pwn'],
  acceptedInputs: ['file_path'],
  executionMode: 'sequential',
  partialFailurePolicy: 'continue',
  requiredTools: ['Bash'],
  stopConditions: [],
  steps: [
    {
      kind: 'tool',
      id: 'p-checksec',
      toolId: 'Bash',
      input: {
        command:
          'which checksec && checksec --file="$FILE_INPUT" 2>&1 || (file "$FILE_INPUT"; readelf -l "$FILE_INPUT" 2>&1 | head -n 30)',
      },
    },
    { kind: 'tool', id: 'p-file', toolId: 'Bash', input: { command: 'file "$FILE_INPUT"' } },
    {
      kind: 'tool',
      id: 'p-strings',
      toolId: 'Bash',
      input: { command: 'strings -n 6 "$FILE_INPUT" | head -n 80' },
    },
    {
      kind: 'tool',
      id: 'p-nm',
      toolId: 'Bash',
      input: {
        command:
          'nm -C "$FILE_INPUT" 2>&1 | grep -iE "main|read|write|exec|system|win|flag|shell" | head -n 40 || true',
      },
    },
    {
      kind: 'tool',
      id: 'p-gdb',
      toolId: 'Bash',
      input: {
        command:
          'gdb -batch -ex "info functions" -ex "disas main" "$FILE_INPUT" 2>&1 | head -n 80 || echo "gdb failed"',
      },
    },
    {
      kind: 'emit_finding',
      id: 'p-summary',
      category: 'pwn',
      title: 'Pwn triage',
      summary: '保护位 + 关键函数 + 段表',
      confidence: 'medium',
      suggestedNextActions: ['request_handoff'],
      suggestedAgent: 'reverse|crypto',
    },
  ],
}

export const WORKFLOW_WEB_TRIAGE: WorkflowDefinition = {
  id: 'web_triage',
  name: 'Web Triage',
  description: 'Web 漏洞初筛:curl HEAD → 路径枚举( gobuster 后台 )→ nmap 后台 → nikto。',
  domains: ['web'],
  acceptedInputs: ['url'],
  executionMode: 'sequential',
  partialFailurePolicy: 'continue',
  requiredTools: ['Bash'],
  stopConditions: [],
  steps: [
    {
      kind: 'tool',
      id: 'w-curl',
      toolId: 'Bash',
      input: {
        command: 'curl -i -L -s -o /dev/null -w "%{http_code} %{size_download}\\n" "$URL_INPUT"',
      },
    },
    {
      kind: 'tool',
      id: 'w-headers',
      toolId: 'Bash',
      input: { command: 'curl -i -L -s "$URL_INPUT" 2>&1 | head -n 60' },
    },
    {
      kind: 'parallel',
      id: 'w-scan',
      join: 'all',
      steps: [
        {
          kind: 'tool',
          id: 'w-gobuster',
          toolId: 'Bash',
          input: {
            command:
              'gobuster dir -u "$URL_INPUT" -w /usr/share/wordlists/dirb/common.txt -t 30 -q 2>&1 | head -n 100 || echo "gobuster unavailable"',
          },
        },
        {
          kind: 'tool',
          id: 'w-nmap',
          toolId: 'Bash',
          input: { command: 'echo "nmap -sV --top-ports 1000 $URL_HOST"' },
        },
      ],
    },
    {
      kind: 'emit_finding',
      id: 'w-summary',
      category: 'web',
      title: 'Web triage',
      summary: '状态码 + headers + 路径/端口',
      confidence: 'medium',
      suggestedNextActions: ['request_handoff'],
      suggestedAgent: 'crypto|file-forensics',
    },
  ],
}

export const WORKFLOW_PCAP_TRIAGE: WorkflowDefinition = {
  id: 'pcap_triage',
  name: 'PCAP Triage',
  description:
    '流量分析初筛:tshark -r → 协议统计 → follow tcp/udp → 导出 HTTP objects → 字符串/密文定位。',
  domains: ['network'],
  acceptedInputs: ['file_path'],
  executionMode: 'sequential',
  partialFailurePolicy: 'continue',
  requiredTools: ['Bash'],
  stopConditions: [],
  steps: [
    {
      kind: 'tool',
      id: 'c-protocol',
      toolId: 'Bash',
      input: { command: 'tshark -r "$FILE_INPUT" -q -z io,phs 2>&1 | head -n 60' },
    },
    {
      kind: 'tool',
      id: 'c-conversations',
      toolId: 'Bash',
      input: { command: 'tshark -r "$FILE_INPUT" -q -z conv,tcp 2>&1 | head -n 40' },
    },
    {
      kind: 'parallel',
      id: 'c-follow',
      join: 'all',
      steps: [
        {
          kind: 'tool',
          id: 'c-http',
          toolId: 'Bash',
          input: {
            command:
              'tshark -r "$FILE_INPUT" -Y "http" -T fields -e http.request.method -e http.request.uri -e http.response.code 2>&1 | head -n 60',
          },
        },
        {
          kind: 'tool',
          id: 'c-dns',
          toolId: 'Bash',
          input: {
            command: 'tshark -r "$FILE_INPUT" -Y "dns" -T fields -e dns.qry.name 2>&1 | head -n 30',
          },
        },
        {
          kind: 'tool',
          id: 'c-tls',
          toolId: 'Bash',
          input: {
            command:
              'tshark -r "$FILE_INPUT" -Y "tls.handshake.extensions_server_name" -T fields -e tls.handshake.extensions_server_name 2>&1 | head -n 30',
          },
        },
      ],
    },
    {
      kind: 'tool',
      id: 'c-strings',
      toolId: 'Bash',
      input: {
        command:
          'strings -n 6 "$FILE_INPUT" | grep -iE "flag|password|key|secret" | head -n 40 || true',
      },
    },
    {
      kind: 'emit_finding',
      id: 'c-summary',
      category: 'traffic',
      title: 'PCAP triage',
      summary: '协议分布 + 主要会话 + flag 关键字命中',
      confidence: 'medium',
      suggestedNextActions: ['request_handoff'],
      suggestedAgent: 'file-forensics|crypto|reverse',
    },
  ],
}

export const BUILTIN_WORKFLOWS: WorkflowDefinition[] = [
  WORKFLOW_UNKNOWN_FILE_TRIAGE,
  WORKFLOW_IMAGE_QUICK_SCAN,
  WORKFLOW_ENCODING_SWEEP,
  WORKFLOW_RSA_COMMON_ATTACKS,
  WORKFLOW_XOR_KNOWN_ATTACK,
  WORKFLOW_AES_ECB_ATTACK,
  WORKFLOW_BINARY_TRIAGE,
  WORKFLOW_PWN_TRIAGE,
  WORKFLOW_WEB_TRIAGE,
  WORKFLOW_PCAP_TRIAGE,
]
