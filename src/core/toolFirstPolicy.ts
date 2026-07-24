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

/**
 * Mode — six_goal §十一 three-tier escalation.
 *   advisory        → only emit `policy_advisory` event (current behaviour).
 *   require_reason  → broker returns a structured refusal unless the caller
 *                     supplies `__overrideReason` documenting why a mature
 *                     tool was tried first and failed. The model can still
 *                     proceed by providing the override.
 *   enforced        → broker denies the call outright when a matching
 *                     workflow has not yet recorded a failed run. Manual
 *                     work is allowed only after a documented overrideReason.
 */
export type PolicyMode = 'advisory' | 'require_reason' | 'enforced'

export const POLICY_MODES: ReadonlyArray<PolicyMode> = [
  'advisory',
  'require_reason',
  'enforced',
] as const

export interface PolicyVerdict {
  /** A short, model-readable reminder string. Empty = no advice. */
  advice: string
  severity: PolicySeverity
  rule: string
  /** When true, the broker should mutate the tool result to prepend advice. */
  injectInResult: boolean
  /** Suggested workflow id the LLM should run before proceeding. */
  suggestedWorkflowId?: string
}

interface PolicyRule {
  id: string
  /** Default severity when the rule fires. */
  severity: PolicySeverity
  injectInResult: boolean
  /** Match rule against the call site. */
  match(args: {
    toolId: string
    input: Record<string, unknown>
    profile: CapabilityProfile
  }): boolean
  /** Render advice. */
  advice(): string
  /** Optional: the canonical workflow id this rule wants the agent to run. */
  workflowId?(): string
}

const RULE_PORT_SCAN_KEYWORDS = [
  'full port scan',
  'service enumeration',
  'port scan',
  'all ports',
  'complete scan',
  'service detection',
]
const RULE_IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.bmp', '.gif', '.tiff', '.webp']
const RULE_BINARY_EXTS = [
  '.elf',
  '.bin',
  '.so',
  '.out',
  '.exe',
  '.dll',
  '.mach-o',
  '.class',
  '.jar',
  '.apk',
]
const RULE_PCAP_EXTS = ['.pcap', '.pcapng', '.cap']

function fpStr(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value ?? '')
  } catch {
    return String(value)
  }
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
    workflowId: () => 'host_service_enumeration',
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
    workflowId: () => 'image_quick_scan',
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
    workflowId: () => 'rsa_common_attacks',
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
    workflowId: () => 'unknown_file_triage',
    match: ({ toolId, input }) => {
      if (toolId !== 'Bash') return false
      const fp = combinedInputFingerprint(input)
      // Trigger when the agent tries to decode / brute-force an unknown blob.
      return (
        /\b(base64|hex|sha|md5|md4|sha1|entropy|strings|file)\s+/.test(fp) &&
        /unknown|mystery|raw|blob|binary|file_?input/.test(fp)
      )
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
    workflowId: () => 'binary_triage',
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
    workflowId: () => 'web_triage',
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
    workflowId: () => 'pcap_triage',
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
          const verdict: PolicyVerdict = {
            advice: rule.advice(),
            severity: rule.severity,
            rule: rule.id,
            injectInResult: rule.injectInResult,
          }
          const wid = rule.workflowId?.()
          if (wid) verdict.suggestedWorkflowId = wid
          return verdict
        }
      } catch {
        /* bad rule shouldn't break execution */
      }
    }
    return { advice: '', severity: 'info', rule: '__none__', injectInResult: false }
  }
}

/** Test helper — exposes the rule list without exposing internals. */
export function defaultPolicyRules(): PolicyRule[] {
  return [...RULES]
}

/**
 * Enforce mode helper — six_goal §十一 says the broker should refuse
 * hand-rolled scripts when a workflow has not yet recorded a failure.
 *
 * Two cooperating pieces of state are required:
 *   1. `mode` ∈ {advisory, require_reason, enforced};
 *   2. `failedWorkflowIds` — the set of workflow ids that have already run
 *      and recorded a `WORKFLOW_FAILED` (or `partial`) outcome.
 *
 * `evaluatePolicyGate` returns:
 *   { allowed: true }                                  → no advice / advisory only;
 *   { allowed: 'with-reason' }                         → require_reason; caller must pass __overrideReason;
 *   { allowed: false, reason: 'enforced-no-failure' }  → enforced with no failed-workflow evidence.
 *
 * This helper is intentionally pure so the broker / engine can call it.
 */
export interface PolicyGateInput {
  mode: PolicyMode
  toolId: string
  input: Record<string, unknown>
  profile: CapabilityProfile
  failedWorkflowIds: ReadonlyArray<string>
  overrideReason?: string
}

export type PolicyGateResult =
  | { allowed: true }
  | { allowed: 'with-reason' }
  | { allowed: false; reason: string; verdict: PolicyVerdict }

export function evaluatePolicyGate(args: PolicyGateInput): PolicyGateResult {
  const policy = new ToolFirstPolicy()
  const verdict = policy.advise(args.toolId, args.input, args.profile)
  if (!verdict.suggestedWorkflowId) return { allowed: true }

  const suggested = verdict.suggestedWorkflowId
  const failedFor = args.failedWorkflowIds.includes(suggested)
  const hasOverride =
    typeof args.overrideReason === 'string' && args.overrideReason.trim().length > 0

  if (args.mode === 'advisory') return { allowed: true }

  if (args.mode === 'require_reason') {
    if (failedFor || hasOverride) return { allowed: true }
    return { allowed: 'with-reason' }
  }

  // enforced
  if (failedFor || hasOverride) return { allowed: true }
  return { allowed: false, reason: 'enforced: mature workflow must run first', verdict }
}

/**
 * Wire a workflowId into each existing rule by mapping rule id →
 * canonical workflow id. Kept in one place so adding a new rule does not
 * forget the workflow hook (six_goal §十一).
 */
export const RULE_TO_WORKFLOW: Record<string, string> = {
  'web-enumeration': 'host_service_enumeration',
  'image-stego': 'image_quick_scan',
  'rsa-common-attacks': 'rsa_common_attacks',
  'unknown-file-triage': 'unknown_file_triage',
  'reverse-binary-first': 'binary_triage',
  'web-crawl-first': 'web_triage',
  'pcap-extract-first': 'pcap_triage',
}
