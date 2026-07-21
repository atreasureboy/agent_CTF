/**
 * ToolFirstPolicy — rule-based advisor that reminds the model to prefer
 * mature tools over hand-rolled implementations.
 *
 * The Policy is non-blocking by design. When a rule fires, the Broker:
 *   1. Emits a 'policy_advisory' EventLog entry.
 *   2. Optionally prepends the reminder to the tool's result content.
 * The model can still proceed by ignoring the reminder; the override is
 * recorded in the audit trail.
 *
 * Rules are evaluated in priority order; first match wins. Each rule looks at:
 *   - profile (which agent is calling — to scope reminders appropriately)
 *   - toolId  (the tool being called)
 *   - input   (the tool arguments)
 *
 * Built-in starter rules:
 *   1. nmap-first            — when the goal mentions "full port scan" or "service
 *                              enumeration", suggest Workflow -> nmap.
 *   2. image-stego-first     — when input contains a PNG/JPEG, suggest
 *                              image_quick_scan workflow before any pixel-level
 *                              extraction tool.
 *   3. rsa-common-attacks    — when crypto+prime parameters are detected, suggest
 *                              rsa_common_attacks workflow before from-scratch.
 *   4. unknown-file-triage   — when input path has unknown extension, suggest
 *                              unknown_file_triage before exhaustive decoding.
 */

import type { CapabilityProfile } from './capabilityProfile.js'

export type PolicySeverity = 'info' | 'warn' | 'block'

export interface PolicyVerdict {
  /** A short, model-readable reminder string. Empty = no advice. */
  advice: string
  severity: PolicySeverity
  rule: string
  /** When true, the broker should mutate the tool result to prepend advice. */
  injectInResult: boolean
}

interface PolicyRule {
  id: string
  /** Default severity when the rule fires. */
  severity: PolicySeverity
  injectInResult: boolean
  /** Match rule against the call site. */
  match(args: { toolId: string; input: Record<string, unknown>; profile: CapabilityProfile }): boolean
  /** Render advice. */
  advice(): string
}

const RULE_PORT_SCAN_KEYWORDS = ['full port scan', 'service enumeration', 'port scan', 'all ports', 'complete scan', 'service detection']
const RULE_IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.bmp', '.gif', '.tiff', '.webp']
const RULE_BINARY_EXTS = ['.elf', '.bin', '.so', '.out', '.exe', '.dll', '.mach-o', '.class', '.jar', '.apk']
const RULE_PCAP_EXTS = ['.pcap', '.pcapng', '.cap']

function fpStr(value: unknown): string {
  if (typeof value === 'string') return value
  try { return JSON.stringify(value ?? '') } catch { return String(value) }
}

function combinedInputFingerprint(input: Record<string, unknown>): string {
  return Object.values(input ?? {})
    .map((v) => fpStr(v))
    .join(' ')
    .toLowerCase()
}

const RULES: PolicyRule[] = [
  {
    id: 'web-enumeration',
    severity: 'info',
    injectInResult: false,
    match: ({ toolId, input }) => {
      if (toolId !== 'Bash') return false
      const fp = combinedInputFingerprint(input)
      // Trigger only when the agent is touching web/network surfaces and
      // appears to be improvising with curl/nc where a workflow would help.
      return (
        RULE_PORT_SCAN_KEYWORDS.some((kw) => fp.includes(kw)) &&
        /\b(curl|nc|netcat|telnet)\b/.test(fp)
      )
    },
    advice() {
      return (
        'Reminder: this task mentions full port/service enumeration. ' +
        'Consider the host_service_enumeration workflow (nmap in background) before ' +
        'starting per-port curl/nc loops. Parallelise with nmap, keep main flow unblocked.'
      )
    },
  },
  {
    id: 'image-stego',
    severity: 'info',
    injectInResult: false,
    match: ({ toolId, input }) => {
      const fp = combinedInputFingerprint(input)
      const isImage = RULE_IMAGE_EXTS.some((ext) => fp.includes(ext))
      if (!isImage) return false
      // Trigger when the agent is about to manually extract pixels / LSB.
      return (
        toolId === 'Bash' &&
        /(lsb|pixel|bitplane|channel|extract.{0,30}\.png|extract.{0,30}\.jpg)/.test(fp)
      )
    },
    advice() {
      return (
        'Reminder: input appears to be a PNG/JPEG. Before writing a pixel-level ' +
        'extractor, run image_quick_scan (covers binwalk, zsteg, pngcheck, exiftool) ' +
        'and image_embedded_file_scan. Standard tools must be tried first.'
      )
    },
  },
  {
    id: 'rsa-common-attacks',
    severity: 'info',
    injectInResult: false,
    match: ({ toolId, input, profile }) => {
      const fp = combinedInputFingerprint(input)
      if (!/(rsa|n\s*=\s*\d|p\s*=|q\s*=|phi|euler|totient|public.?key|n,e)/.test(fp)) return false
      // CryptoAgent scope — irrelevant to other profiles.
      return profile.id === 'crypto' || profile.id.startsWith('crypto')
    },
    advice() {
      return (
        'Reminder: RSA parameters detected. Run rsa_common_attacks workflow before ' +
        'hand-writing GCD / Fermat / Pollard / Wiener routines. Only override after ' +
        'documented failure of the standard attacks.'
      )
    },
  },
  {
    id: 'unknown-file-triage',
    severity: 'info',
    injectInResult: false,
    match: ({ toolId, input }) => {
      if (toolId !== 'Bash') return false
      const fp = combinedInputFingerprint(input)
      // Trigger when the agent tries to decode / brute-force an unknown blob.
      return /\b(base64|hex|sha|md5|md4|sha1|entropy|strings|file)\s+/.test(fp) &&
        /unknown|mystery|raw|blob|binary|file_?input/.test(fp)
    },
    advice() {
      return (
        'Reminder: input looks like an unclassified file. Run unknown_file_triage ' +
        '(file + exiftool + magic + entropy heuristic) before attempting decoding.'
      )
    },
  },
  {
    id: 'reverse-binary-first',
    severity: 'info',
    injectInResult: false,
    match: ({ toolId, input, profile }) => {
      if (profile.id !== 'reverse') return false
      if (toolId !== 'Bash') return false
      const fp = combinedInputFingerprint(input)
      // Trigger when the agent is about to hand-disassemble a binary before
      // running the standard triage workflow.
      const isBinary = RULE_BINARY_EXTS.some((ext) => fp.includes(ext))
      if (!isBinary) return false
      return /(xxd|hexdump|od\s+|disas|disassemble|hex.{0,10}dump|readelf)/.test(fp)
    },
    advice() {
      return (
        'Reminder: input is an ELF/binary. Run binary_triage workflow (file + strings + ' +
        'nm + objdump + r2) before hand-disassembling. Standard tools must be tried first.'
      )
    },
  },
  {
    id: 'web-crawl-first',
    severity: 'info',
    injectInResult: false,
    match: ({ toolId, input, profile }) => {
      if (profile.id !== 'web') return false
      if (toolId !== 'Bash') return false
      const fp = combinedInputFingerprint(input)
      // Trigger when the agent is about to hand-fuzz paths / curl-loop instead
      // of running the standard triage workflow.
      const looksUrlish = /https?:\/\/|www\./.test(fp)
      if (!looksUrlish) return false
      return /(curl\s+-L\s+.*?for|for\s+path|loop.{0,10}url|brute.{0,10}path|wfuzz|ffuf)/.test(fp)
    },
    advice() {
      return (
        'Reminder: input is a URL. Run web_triage workflow (curl HEAD + gobuster + nmap) ' +
        'before hand-fuzzing paths. Long scans should be background jobs.'
      )
    },
  },
  {
    id: 'pcap-extract-first',
    severity: 'info',
    injectInResult: false,
    match: ({ toolId, input, profile }) => {
      if (profile.id !== 'traffic') return false
      if (toolId !== 'Bash') return false
      const fp = combinedInputFingerprint(input)
      const isPcap = RULE_PCAP_EXTS.some((ext) => fp.includes(ext))
      if (!isPcap) return false
      // Trigger when the agent is about to write a pcap parser manually.
      return /(scapy|dpkt|pyshark|python.{0,30}pcap|parse.{0,20}packet)/.test(fp)
    },
    advice() {
      return (
        'Reminder: input is a pcap. Run pcap_triage workflow (tshark + protocol stats + ' +
        'follow tcp + extract objects) before hand-writing a parser with scapy/dpkt.'
      )
    },
  },
]

export class ToolFirstPolicy {
  private rules: PolicyRule[]

  constructor(extra: PolicyRule[] = []) {
    this.rules = [...RULES, ...extra]
  }

  advise(
    toolId: string,
    input: Record<string, unknown>,
    profile: CapabilityProfile,
  ): PolicyVerdict {
    for (const rule of this.rules) {
      try {
        if (rule.match({ toolId, input, profile })) {
          return {
            advice: rule.advice(),
            severity: rule.severity,
            rule: rule.id,
            injectInResult: rule.injectInResult,
          }
        }
      } catch { /* bad rule shouldn't break execution */ }
    }
    return { advice: '', severity: 'info', rule: '__none__', injectInResult: false }
  }
}

/** Test helper — exposes the rule list without exposing internals. */
export function defaultPolicyRules(): PolicyRule[] {
  return [...RULES]
}
