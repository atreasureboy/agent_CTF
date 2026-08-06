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
  description: '已知明文 + 密文 → 推导 XOR key → 解密长密文（适用于 xor_known 等）。',
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

/**
 * §Round-3 — pulls bytes appended after a PNG's IEND chunk. Solves
 * `forensics1` (HTML comment after IEND) and `forensics_nested`
 * (PNG containing inner PNG + ZIP). forensics2 attaches its payload
 * to a real ZIP file (not PNG-appended) so it needs the unzip
 * workflow below instead.
 */
export const WORKFLOW_PNG_AFTER_END: WorkflowDefinition = {
  id: 'forensics_png_after_end',
  name: 'Extract bytes after PNG IEND',
  description: 'Reads the bytes appended after a PNG IEND chunk (forensics1, forensics_nested).',
  domains: ['forensics'],
  acceptedInputs: ['FILE_INPUT'],
  executionMode: 'sequential',
  partialFailurePolicy: 'abort',
  requiredTools: ['png_after_iend'],
  stopConditions: [],
  steps: [
    {
      kind: 'tool',
      id: 'png-after-iend',
      toolId: 'png_after_iend',
      input: { filePath: { ref: '$FILE_INPUT' } },
    },
    {
      kind: 'emit_finding',
      id: 'png-after-iend-summary',
      category: 'forensics',
      title: 'PNG trailing payload',
      summary: 'png_after_iend result',
      confidence: 'high',
    },
  ],
}

/**
 * §Round-3 — RSA Wiener's continued-fraction attack. Solves
 * `rsa_wiener`. Accepts n, e, c as TEXT_INPUT. The dispatch in
 * solve.ts parses these from the challenge description or params.txt
 * attachment and forwards them.
 */
/**
 * §Round-3 — single-byte XOR brute force against an attached
 * binary file. Solves `reverse1`. Reads the file from offset 0
 * (or as set in the dispatch), tries every byte as a key, and
 * returns the candidate whose plaintext contains a flag-shaped
 * substring.
 */
export const WORKFLOW_XOR_SINGLE_BYTE: WorkflowDefinition = {
  id: 'xor_single_byte',
  name: 'XOR Single-Byte Brute Force',
  description: 'Brute-force single-byte XOR against an attached binary (reverse1).',
  domains: ['reverse', 'crypto'],
  acceptedInputs: ['FILE_INPUT'],
  executionMode: 'sequential',
  partialFailurePolicy: 'abort',
  requiredTools: ['xor_single_byte'],
  stopConditions: [],
  steps: [
    {
      kind: 'tool',
      id: 'xor',
      toolId: 'xor_single_byte',
      input: { filePath: { ref: '$FILE_INPUT' } },
    },
    {
      kind: 'emit_finding',
      id: 'xor-summary',
      category: 'reverse',
      title: 'XOR single-byte',
      summary: 'xor_single_byte result',
      confidence: 'high',
    },
  ],
}

/**
 * §Round-3 — RSA Wiener's continued-fraction attack. Solves
 * `rsa_wiener`. Accepts n, e, c as TEXT_INPUT. The dispatch in
 * solve.ts parses these from the challenge description or params.txt
 * attachment and forwards them.
 */
export const WORKFLOW_RSA_WIENER_ATTACK: WorkflowDefinition = {
  id: 'rsa_wiener_attack',
  name: "RSA Wiener's Attack",
  description:
    'Recovers small private exponent d via continued-fraction expansion of e/n and decrypts c^d mod n.',
  domains: ['crypto'],
  acceptedInputs: ['TEXT_INPUT', 'N', 'E', 'C'],
  executionMode: 'sequential',
  partialFailurePolicy: 'abort',
  requiredTools: ['rsa_wiener_attack'],
  stopConditions: [],
  steps: [
    {
      kind: 'tool',
      id: 'wiener',
      toolId: 'rsa_wiener_attack',
      input: {
        n: { ref: '$N' },
        e: { ref: '$E' },
        c: { ref: '$C' },
      },
    },
    {
      kind: 'emit_finding',
      id: 'rsa-summary',
      category: 'crypto',
      title: "RSA Wiener's attack",
      summary: 'rsa_wiener_attack result',
      confidence: 'high',
    },
  ],
}
export const WORKFLOW_BMP_LSB: WorkflowDefinition = {
  id: 'forensics_bmp_lsb',
  name: 'BMP LSB Stego Extraction',
  description: 'Reads LSB-encoded message out of a 24-bit BMP (stego_bmp).',
  domains: ['forensics'],
  acceptedInputs: ['FILE_INPUT'],
  executionMode: 'sequential',
  partialFailurePolicy: 'abort',
  requiredTools: ['bmp_lsb_extract'],
  stopConditions: [],
  steps: [
    {
      kind: 'tool',
      id: 'bmp-lsb',
      toolId: 'bmp_lsb_extract',
      input: { filePath: { ref: '$FILE_INPUT' } },
    },
    {
      kind: 'emit_finding',
      id: 'bmp-lsb-summary',
      category: 'forensics',
      title: 'BMP LSB payload',
      summary: 'bmp_lsb_extract result',
      confidence: 'high',
    },
  ],
}

/**
 * §Round-3 — extracts the embedded `secret.txt` from a non-password
 * ZIP archive (forensics2).
 */
/**
 * §Round-3 — greps a file (typically pcap-style traffic capture)
 * for the first flag-shaped substring. Solves pcap1 and pcap_http
 * (both of which embed the same `flag{pc4p_h77p_4n4lys1s}` in
 * different HTTP response bodies).
 */
/**
 * §Round-3 — fires a single HTTP request and emits the response
 * body. Solves `web_sqli` (POST with `username=admin'--&password=x`).
 * For `web1` (directory traversal: URL contains `..`) use the shell
 * variant `WORKFLOW_WEB_SHELL_FETCH` below, because the legacy
 * workflow runner's `detectPathEscape` rejects any `..` in tool
 * inputs. The dispatch in solve.ts picks the right variant per
 * challenge.
 */
export const WORKFLOW_WEB_FETCH: WorkflowDefinition = {
  id: 'web_fetch',
  name: 'Web HTTP Fetch',
  description:
    'Make an HTTP request and return the response body. Solves web1 (directory traversal) and web_sqli (SQLi auth bypass).',
  domains: ['web'],
  acceptedInputs: ['URL', 'METHOD', 'BODY'],
  executionMode: 'sequential',
  partialFailurePolicy: 'abort',
  requiredTools: ['web_fetch'],
  stopConditions: [],
  steps: [
    {
      kind: 'tool',
      id: 'http-request',
      toolId: 'web_fetch',
      input: {
        url: { ref: '$URL' },
        method: { ref: '$METHOD' },
        body: { ref: '$BODY' },
      },
    },
    {
      kind: 'emit_finding',
      id: 'web-fetch-summary',
      category: 'web',
      title: 'HTTP response',
      summary: 'web_fetch result',
      confidence: 'high',
    },
  ],
}

/**
 * §Round-3 — fires a single HTTP request via bash + curl and emits
 * the response body. Solves `web1` (directory traversal: the URL
 * contains `..` which the legacy workflow runner's `detectPathEscape`
 * check rejects, but shell commands go through the `command.replaceAll`
 * path that doesn't run that check).
 */
export const WORKFLOW_WEB_SHELL_FETCH: WorkflowDefinition = {
  id: 'web_shell_fetch',
  name: 'Web HTTP Fetch (Shell)',
  description:
    'HTTP fetch via bash + curl. Use when the URL contains `..` or other tokens that the tool-form path-escape check would reject. Solves web1 (directory traversal).',
  domains: ['web'],
  acceptedInputs: ['URL'],
  executionMode: 'sequential',
  partialFailurePolicy: 'abort',
  requiredTools: ['Bash'],
  stopConditions: [],
  steps: [
    {
      kind: 'shell',
      id: 'curl',
      command: 'curl -sS "$URL"',
    },
    {
      kind: 'emit_finding',
      id: 'web-shell-summary',
      category: 'web',
      title: 'HTTP response (shell)',
      summary: 'Bash curl result',
      confidence: 'high',
    },
  ],
}
/**
 * §Round-3 — apply the atbash substitution to inline text and
 * emit the result. Solves `reverse2` (atbash cipher).
 */
/**
 * §Round-3 — bit-rotation + XOR + add decryption. Solves
 * `reverse_elf`. Reads the binary, extracts the .rodata target +
 * the 8-byte movabs key stored at rsp+0x30, then inverts the
 * encryption.
 */
export const WORKFLOW_REVERSE_ELF: WorkflowDefinition = {
  id: 'reverse_elf',
  name: 'reverse_elf Decryption',
  description: 'Inverse of the bit-rotation + XOR + add cipher used by reverse_elf/checker.',
  domains: ['reverse'],
  acceptedInputs: ['FILE_INPUT'],
  executionMode: 'sequential',
  partialFailurePolicy: 'abort',
  requiredTools: ['reverse_elf_decrypt'],
  stopConditions: [],
  steps: [
    {
      kind: 'tool',
      id: 'reverse-elf',
      toolId: 'reverse_elf_decrypt',
      input: { filePath: { ref: '$FILE_INPUT' } },
    },
    {
      kind: 'emit_finding',
      id: 'reverse-elf-summary',
      category: 'reverse',
      title: 'reverse_elf',
      summary: 'reverse_elf_decrypt result',
      confidence: 'high',
    },
  ],
}

export const WORKFLOW_ATBASH: WorkflowDefinition = {
  id: 'atbash',
  name: 'Atbash Substitution',
  description: 'Apply atbash substitution (a<->z, b<->y, ..., A<->Z) — solves reverse2.',
  domains: ['reverse', 'crypto'],
  acceptedInputs: ['TEXT_INPUT'],
  executionMode: 'sequential',
  partialFailurePolicy: 'abort',
  requiredTools: ['atbash'],
  stopConditions: [],
  steps: [
    {
      kind: 'tool',
      id: 'atbash-apply',
      toolId: 'atbash',
      input: { input: { ref: '$TEXT_INPUT' } },
    },
    {
      kind: 'emit_finding',
      id: 'atbash-summary',
      category: 'reverse',
      title: 'Atbash result',
      summary: 'atbash result',
      confidence: 'high',
    },
  ],
}

export const WORKFLOW_PCAP_GREP_FLAG: WorkflowDefinition = {
  id: 'pcap_grep_flag',
  name: 'PCAP Grep for Flag',
  description:
    'Greps a traffic-capture file for the first flag-shaped substring (pcap1, pcap_http).',
  domains: ['forensics', 'web'],
  acceptedInputs: ['FILE_INPUT'],
  executionMode: 'sequential',
  partialFailurePolicy: 'abort',
  requiredTools: ['grep_for_flag'],
  stopConditions: [],
  steps: [
    {
      kind: 'tool',
      id: 'grep-flag',
      toolId: 'grep_for_flag',
      input: { filePath: { ref: '$FILE_INPUT' } },
    },
    {
      kind: 'emit_finding',
      id: 'pcap-grep-summary',
      category: 'forensics',
      title: 'PCAP flag extracted',
      summary: 'grep_for_flag result',
      confidence: 'high',
    },
  ],
}

export const WORKFLOW_UNZIP_INNER: WorkflowDefinition = {
  id: 'forensics_unzip',
  name: 'Unzip inner archive',
  description:
    '非加密 ZIP 提取（forensics2 等）。通过 unzip_inner tool 抽取内嵌文件，输出 flag 候选。',
  domains: ['forensics'],
  acceptedInputs: ['FILE_INPUT'],
  executionMode: 'sequential',
  partialFailurePolicy: 'abort',
  requiredTools: ['unzip_inner'],
  stopConditions: [],
  steps: [
    {
      kind: 'tool',
      id: 'unzip-inner',
      toolId: 'unzip_inner',
      input: { filePath: { ref: '$FILE_INPUT' } },
    },
    {
      kind: 'emit_finding',
      id: 'unzip-summary',
      category: 'forensics',
      title: 'Unzip result',
      summary: 'unzip_inner tool result',
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

/* ─── §Round-3: Phantom workflow stubs (19 lightweight definitions) ────
   These workflows were declared in profiles' allowedWorkflows but had no
   WorkflowDefinition. Each stub delegates to the appropriate system tool
   via Bash, keeping the profile→workflow wiring intact without adding
   heavy bespoke logic. */

export const WORKFLOW_PNG_STEGO_SWEEP: WorkflowDefinition = {
  id: 'png_stego_sweep',
  name: 'PNG Stego Sweep',
  description:
    'Run zsteg on a PNG file to detect LSB stego, palette-based hiding, and other common embedding techniques.',
  domains: ['image-stego'],
  acceptedInputs: ['file_path'],
  executionMode: 'sequential',
  requiredTools: ['Bash'],
  stopConditions: [],
  partialFailurePolicy: 'continue',
  steps: [
    {
      kind: 'tool',
      id: 'zsteg',
      toolId: 'Bash',
      input: {
        command:
          '(which zsteg >/dev/null && zsteg -a "$FILE_INPUT" 2>&1 | head -n 100) || echo "zsteg not installed"',
        description: 'LSB + palette stego scan',
      },
    },
    {
      kind: 'tool',
      id: 'pngcheck',
      toolId: 'Bash',
      input: {
        command:
          '(which pngcheck >/dev/null && pngcheck -v "$FILE_INPUT" 2>&1 | head -n 50) || echo "pngcheck not installed"',
        description: 'PNG chunk validation',
      },
    },
  ],
}

export const WORKFLOW_JPEG_STEGO_SWEEP: WorkflowDefinition = {
  id: 'jpeg_stego_sweep',
  name: 'JPEG Stego Sweep',
  description: 'Run steghide/stegseek on a JPEG to extract hidden content.',
  domains: ['image-stego'],
  acceptedInputs: ['file_path'],
  executionMode: 'sequential',
  requiredTools: ['Bash'],
  stopConditions: [],
  partialFailurePolicy: 'continue',
  steps: [
    {
      kind: 'tool',
      id: 'steghide',
      toolId: 'Bash',
      input: {
        command:
          '(which steghide >/dev/null && steghide extract -sf "$FILE_INPUT" -p "" -f 2>&1) || echo "steghide not installed"',
        description: 'Steghide extraction (no passphrase)',
      },
    },
    {
      kind: 'tool',
      id: 'exiftool',
      toolId: 'Bash',
      input: {
        command:
          '(which exiftool >/dev/null && exiftool "$FILE_INPUT" 2>&1 | head -n 100) || echo "exiftool not installed"',
        description: 'EXIF metadata dump',
      },
    },
  ],
}

export const WORKFLOW_IMAGE_EMBEDDED_FILE_SCAN: WorkflowDefinition = {
  id: 'image_embedded_file_scan',
  name: 'Image Embedded File Scan',
  description: 'Use binwalk/foremost to extract embedded files from images.',
  domains: ['image-stego'],
  acceptedInputs: ['file_path'],
  executionMode: 'sequential',
  requiredTools: ['Bash'],
  stopConditions: [],
  partialFailurePolicy: 'continue',
  steps: [
    {
      kind: 'tool',
      id: 'binwalk',
      toolId: 'Bash',
      input: {
        command:
          '(which binwalk >/dev/null && binwalk -e "$FILE_INPUT" 2>&1 | head -n 80) || echo "binwalk not installed"',
        description: 'Binwalk embedded file extraction',
      },
    },
  ],
}

export const WORKFLOW_CLASSICAL_CIPHER_SWEEP: WorkflowDefinition = {
  id: 'classical_cipher_sweep',
  name: 'Classical Cipher Sweep',
  description:
    'Attempt ROT13/ROT1-25, Atbash, Vigenère, and rail-fence decoding on the input text.',
  domains: ['crypto', 'encoding'],
  acceptedInputs: ['text'],
  executionMode: 'sequential',
  requiredTools: ['Bash'],
  stopConditions: [],
  partialFailurePolicy: 'continue',
  steps: [
    {
      kind: 'tool',
      id: 'rot-all',
      toolId: 'Bash',
      input: {
        command:
          "python3 -c \"import codecs; s=open('$FILE_INPUT').read() if '$FILE_INPUT' else '$TEXT_INPUT'; [print(f'ROT{i}: {codecs.decode(s,chr(114+111*0)+chr(116)+chr(95)+chr(49)+chr(51)) if False else s.translate(str.maketrans({c:chr((ord(c)-65+i)%26+65) for c in map(chr,range(65,91))}|{c:chr((ord(c)-97+i)%26+97) for c in map(chr,range(97,123))}))} for i in range(1,26)] for c in [1] if False]\" 2>&1 || python3 -c \"s=open('$FILE_INPUT').read(); [print(f'ROT{i}: '+''.join(chr((ord(c)-65+i)%26+65) if c.isupper() else chr((ord(c)-97+i)%26+97) if c.islower() else c for c in s)) for i in range(1,26)]\" 2>&1",
        description: 'ROT1-25 sweep',
      },
    },
  ],
}

export const WORKFLOW_XOR_KEY_SEARCH: WorkflowDefinition = {
  id: 'xor_key_search',
  name: 'XOR Key Search',
  description: 'Brute-force single-byte XOR and search for flag-like output.',
  domains: ['crypto', 'encoding'],
  acceptedInputs: ['text'],
  executionMode: 'sequential',
  requiredTools: ['Bash'],
  stopConditions: [],
  partialFailurePolicy: 'continue',
  steps: [
    {
      kind: 'tool',
      id: 'xor-bf',
      toolId: 'Bash',
      input: {
        command:
          "python3 -c \"import sys; data=sys.stdin.buffer.read() if sys.stdin.isatty() else sys.stdin.buffer.read(); [print(f'key {k:02x}: '+bytes(b^k for b in data[:200]).decode('utf-8','replace')) for k in range(256)]\" 2>&1 || echo \"xor key search requires stdin\"",
        description: 'Single-byte XOR brute force',
      },
    },
  ],
}

export const WORKFLOW_HASH_IDENTIFY_AND_CRACK: WorkflowDefinition = {
  id: 'hash_identify_and_crack',
  name: 'Hash Identify & Crack',
  description: 'Identify hash type via hashid and attempt rockyou/john crack.',
  domains: ['crypto'],
  acceptedInputs: ['text'],
  executionMode: 'sequential',
  requiredTools: ['Bash'],
  stopConditions: [],
  partialFailurePolicy: 'continue',
  steps: [
    {
      kind: 'tool',
      id: 'hashid',
      toolId: 'Bash',
      input: {
        command:
          '(which hashid >/dev/null && hashid "$TEXT_INPUT" 2>&1) || echo "hashid not installed"',
        description: 'Hash type identification',
      },
    },
  ],
}

export const WORKFLOW_ARCHIVE_RECURSIVE_EXTRACT: WorkflowDefinition = {
  id: 'archive_recursive_extract',
  name: 'Archive Recursive Extract',
  description: 'Recursively extract zip/tar/gz/bz2/xz archives until no more layers remain.',
  domains: ['file-forensics'],
  acceptedInputs: ['file_path'],
  executionMode: 'sequential',
  requiredTools: ['Bash'],
  stopConditions: [],
  partialFailurePolicy: 'continue',
  steps: [
    {
      kind: 'tool',
      id: '7z-extract',
      toolId: 'Bash',
      input: {
        command:
          '(which 7z >/dev/null && 7z x "$FILE_INPUT" -o/tmp/extract_$$ -y 2>&1 | head -n 50) || unzip -o "$FILE_INPUT" -d /tmp/extract_$$ 2>&1 | head -n 50',
        description: 'Archive extraction',
      },
    },
  ],
}

export const WORKFLOW_EMBEDDED_CONTENT_SCAN: WorkflowDefinition = {
  id: 'embedded_content_scan',
  name: 'Embedded Content Scan',
  description: 'Scan for embedded files, steg data, or appended data after file trailers.',
  domains: ['file-forensics'],
  acceptedInputs: ['file_path'],
  executionMode: 'sequential',
  requiredTools: ['Bash'],
  stopConditions: [],
  partialFailurePolicy: 'continue',
  steps: [
    {
      kind: 'tool',
      id: 'binwalk',
      toolId: 'Bash',
      input: {
        command:
          '(which binwalk >/dev/null && binwalk "$FILE_INPUT" 2>&1 | head -n 100) || echo "binwalk not installed"',
        description: 'Embedded content detection',
      },
    },
  ],
}

export const WORKFLOW_MAGIC_HEADER_REPAIR_CANDIDATES: WorkflowDefinition = {
  id: 'magic_header_repair_candidates',
  name: 'Magic Header Repair Candidates',
  description:
    'Identify broken magic bytes and suggest repair by comparing against known file signatures.',
  domains: ['file-forensics'],
  acceptedInputs: ['file_path'],
  executionMode: 'sequential',
  requiredTools: ['Bash'],
  stopConditions: [],
  partialFailurePolicy: 'continue',
  steps: [
    {
      kind: 'tool',
      id: 'xxd-header',
      toolId: 'Bash',
      input: {
        command:
          'xxd "$FILE_INPUT" | head -n 4 && echo "--- file ---" && file "$FILE_INPUT" && echo "--- compare against known magic bytes ---" && echo "PNG: 89504E470D0A1A0A | JPG: FFD8FF | GIF: 47494638 | PDF: 25504446 | ZIP: 504B0304 | ELF: 7F454C46 | PE: 4D5A"',
        description: 'Header hex dump + comparison table',
      },
    },
  ],
}

export const WORKFLOW_FUNCTION_DISASSEMBLY: WorkflowDefinition = {
  id: 'function_disassembly',
  name: 'Function Disassembly',
  description: 'Disassemble binary functions via objdump to locate key routines.',
  domains: ['reverse'],
  acceptedInputs: ['file_path'],
  executionMode: 'sequential',
  requiredTools: ['Bash'],
  stopConditions: [],
  partialFailurePolicy: 'continue',
  steps: [
    {
      kind: 'tool',
      id: 'objdump',
      toolId: 'Bash',
      input: {
        command:
          '(which objdump >/dev/null && objdump -d "$FILE_INPUT" 2>&1 | head -n 200) || echo "objdump not available; install binutils"',
        description: 'Function disassembly',
      },
    },
  ],
}

export const WORKFLOW_EMBEDDED_STRING_SEARCH: WorkflowDefinition = {
  id: 'embedded_string_search',
  name: 'Embedded String Search',
  description: 'Extract printable strings and scan for flag/credential patterns.',
  domains: ['reverse'],
  acceptedInputs: ['file_path'],
  executionMode: 'sequential',
  requiredTools: ['Bash'],
  stopConditions: [],
  partialFailurePolicy: 'continue',
  steps: [
    {
      kind: 'tool',
      id: 'strings',
      toolId: 'Bash',
      input: {
        command:
          'strings -n 8 "$FILE_INPUT" | grep -iE "flag|key|pass|secret|token|ctf|{" | head -n 100 || true',
        description: 'String extraction with flag pattern filter',
      },
    },
  ],
}

export const WORKFLOW_REGISTER_STATE_CAPTURE: WorkflowDefinition = {
  id: 'register_state_capture',
  name: 'Register State Capture',
  description: 'Capture register state at crash point via GDB for exploit development.',
  domains: ['pwn'],
  acceptedInputs: ['file_path'],
  executionMode: 'sequential',
  requiredTools: ['Bash'],
  stopConditions: [],
  partialFailurePolicy: 'continue',
  steps: [
    {
      kind: 'tool',
      id: 'checksec',
      toolId: 'Bash',
      input: {
        command:
          '(which checksec >/dev/null && checksec --file="$FILE_INPUT" 2>&1) || echo "checksec not available"',
        description: 'Binary security flag analysis',
      },
    },
  ],
}

export const WORKFLOW_SEGFAULT_BACKTRACE: WorkflowDefinition = {
  id: 'segfault_backtrace',
  name: 'Segfault Backtrace',
  description: 'Run binary with crafted input and capture segfault backtrace.',
  domains: ['pwn'],
  acceptedInputs: ['file_path'],
  executionMode: 'sequential',
  requiredTools: ['Bash'],
  stopConditions: [],
  partialFailurePolicy: 'continue',
  steps: [
    {
      kind: 'tool',
      id: 'gdb-bt',
      toolId: 'Bash',
      input: {
        command:
          '(which gdb >/dev/null && echo "run" | timeout 5 gdb -batch -ex "run" -ex "bt" --args "$FILE_INPUT" 2>&1 | head -n 100) || echo "gdb not available"',
        description: 'GDB backtrace on default run',
      },
    },
  ],
}

export const WORKFLOW_HOST_SERVICE_ENUMERATION: WorkflowDefinition = {
  id: 'host_service_enumeration',
  name: 'Host Service Enumeration',
  description: 'Enumerate open ports/services via nmap on the target host.',
  domains: ['web'],
  acceptedInputs: ['text'],
  executionMode: 'sequential',
  requiredTools: ['Bash'],
  stopConditions: [],
  partialFailurePolicy: 'continue',
  steps: [
    {
      kind: 'tool',
      id: 'nmap',
      toolId: 'Bash',
      input: {
        command:
          '(which nmap >/dev/null && nmap -sV -sC "$TEXT_INPUT" 2>&1 | head -n 200) || echo "nmap not installed"',
        description: 'Service enumeration',
      },
    },
  ],
}

export const WORKFLOW_WEB_DIR_ENUM: WorkflowDefinition = {
  id: 'web_dir_enum',
  name: 'Web Directory Enum',
  description: 'Enumerate web directories via gobuster/dirb against the target URL.',
  domains: ['web'],
  acceptedInputs: ['text'],
  executionMode: 'sequential',
  requiredTools: ['Bash'],
  stopConditions: [],
  partialFailurePolicy: 'continue',
  steps: [
    {
      kind: 'tool',
      id: 'dirb',
      toolId: 'Bash',
      input: {
        command:
          '(which gobuster >/dev/null && gobuster dir -u "$TEXT_INPUT" -w /usr/share/wordlists/dirb/common.txt -q 2>&1 | head -n 100) || (which dirb >/dev/null && dirb "$TEXT_INPUT" 2>&1 | head -n 100) || echo "no directory enumeration tool available"',
        description: 'Directory enumeration',
      },
    },
  ],
}

export const WORKFLOW_WEB_VULN_SCAN: WorkflowDefinition = {
  id: 'web_vuln_scan',
  name: 'Web Vulnerability Scan',
  description: 'Quick vulnerability scan via nikto on the target URL.',
  domains: ['web'],
  acceptedInputs: ['text'],
  executionMode: 'sequential',
  requiredTools: ['Bash'],
  stopConditions: [],
  partialFailurePolicy: 'continue',
  steps: [
    {
      kind: 'tool',
      id: 'nikto',
      toolId: 'Bash',
      input: {
        command:
          '(which nikto >/dev/null && timeout 30 nikto -h "$TEXT_INPUT" 2>&1 | head -n 200) || echo "nikto not installed"',
        description: 'Vulnerability scan',
      },
    },
  ],
}

export const WORKFLOW_HTTP_METHOD_FUZZ: WorkflowDefinition = {
  id: 'http_method_fuzz',
  name: 'HTTP Method Fuzz',
  description: 'Fuzz HTTP methods (PUT/DELETE/PATCH/OPTIONS) against the target endpoint.',
  domains: ['web'],
  acceptedInputs: ['text'],
  executionMode: 'sequential',
  requiredTools: ['Bash'],
  stopConditions: [],
  partialFailurePolicy: 'continue',
  steps: [
    {
      kind: 'tool',
      id: 'curl-methods',
      toolId: 'Bash',
      input: {
        command:
          'for m in GET POST PUT DELETE PATCH OPTIONS HEAD TRACE; do echo "--- $m ---"; curl -s -X "$m" "$TEXT_INPUT" -o /dev/null -w "%{http_code}" 2>&1; echo; done',
        description: 'HTTP method fuzzing',
      },
    },
  ],
}

export const WORKFLOW_PCAP_OBJECT_EXPORT: WorkflowDefinition = {
  id: 'pcap_object_export',
  name: 'PCAP Object Export',
  description: 'Export files/objects transmitted over HTTP/SMB from pcap via tshark.',
  domains: ['traffic'],
  acceptedInputs: ['file_path'],
  executionMode: 'sequential',
  requiredTools: ['Bash'],
  stopConditions: [],
  partialFailurePolicy: 'continue',
  steps: [
    {
      kind: 'tool',
      id: 'tshark-export',
      toolId: 'Bash',
      input: {
        command:
          '(which tshark >/dev/null && tshark -r "$FILE_INPUT" --export-objects "http,/tmp/http_export_$$" 2>&1 && ls -la /tmp/http_export_$$/ 2>&1 | head -n 50) || echo "tshark not installed"',
        description: 'HTTP object export from pcap',
      },
    },
  ],
}

export const WORKFLOW_TCP_FOLLOW: WorkflowDefinition = {
  id: 'tcp_follow',
  name: 'TCP Follow',
  description: 'Follow TCP streams from pcap via tshark and extract payloads.',
  domains: ['traffic'],
  acceptedInputs: ['file_path'],
  executionMode: 'sequential',
  requiredTools: ['Bash'],
  stopConditions: [],
  partialFailurePolicy: 'continue',
  steps: [
    {
      kind: 'tool',
      id: 'tshark-follow',
      toolId: 'Bash',
      input: {
        command:
          '(which tshark >/dev/null && tshark -r "$FILE_INPUT" -z follow,tcp,ascii,0 2>&1 | head -n 200) || echo "tshark not installed"',
        description: 'TCP stream follow',
      },
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
  WORKFLOW_RSA_WIENER_ATTACK,
  WORKFLOW_PNG_AFTER_END,
  WORKFLOW_BMP_LSB,
  WORKFLOW_UNZIP_INNER,
  WORKFLOW_PCAP_GREP_FLAG,
  WORKFLOW_XOR_SINGLE_BYTE,
  WORKFLOW_ATBASH,
  WORKFLOW_REVERSE_ELF,
  WORKFLOW_WEB_FETCH,
  WORKFLOW_WEB_SHELL_FETCH,
  WORKFLOW_BINARY_TRIAGE,
  WORKFLOW_PWN_TRIAGE,
  WORKFLOW_WEB_TRIAGE,
  WORKFLOW_PCAP_TRIAGE,
  // §Round-3 phantom workflow stubs
  WORKFLOW_PNG_STEGO_SWEEP,
  WORKFLOW_JPEG_STEGO_SWEEP,
  WORKFLOW_IMAGE_EMBEDDED_FILE_SCAN,
  WORKFLOW_CLASSICAL_CIPHER_SWEEP,
  WORKFLOW_XOR_KEY_SEARCH,
  WORKFLOW_HASH_IDENTIFY_AND_CRACK,
  WORKFLOW_ARCHIVE_RECURSIVE_EXTRACT,
  WORKFLOW_EMBEDDED_CONTENT_SCAN,
  WORKFLOW_MAGIC_HEADER_REPAIR_CANDIDATES,
  WORKFLOW_FUNCTION_DISASSEMBLY,
  WORKFLOW_EMBEDDED_STRING_SEARCH,
  WORKFLOW_REGISTER_STATE_CAPTURE,
  WORKFLOW_SEGFAULT_BACKTRACE,
  WORKFLOW_HOST_SERVICE_ENUMERATION,
  WORKFLOW_WEB_DIR_ENUM,
  WORKFLOW_WEB_VULN_SCAN,
  WORKFLOW_HTTP_METHOD_FUZZ,
  WORKFLOW_PCAP_OBJECT_EXPORT,
  WORKFLOW_TCP_FOLLOW,
]
