/**
 * ChallengeClassifier — deterministic rule-based pre-flight triage for
 * competition solving. Classifies every challenge into a tier (fast /
 * medium / heavy) and recommends the oneshot manifests that are most
 * likely to solve it, so the batch solver can route fast challenges
 * directly to oneshot tools (zero LLM calls) and escalate only when
 * necessary.
 *
 * This runs BEFORE any LLM turn — it is a pure function of the challenge
 * metadata (category, description keywords, attachment hints).
 */

import type { OneShotCatalog } from '../oneshot/catalog.js'
import type { QueuedChallenge } from '../../core/ctfRuntime/challengeConcurrencyPool.js'

// ── Tier ─────────────────────────────────────────────────────────────────

export type ChallengeTier = 'fast' | 'medium' | 'heavy'

// ── Classification result ────────────────────────────────────────────────

export interface ClassificationResult {
  tier: ChallengeTier
  confidence: number // 0-1
  recommendedManifests: string[] // oneshot manifest IDs
  features: ClassificationFeatures
}

export interface ClassificationFeatures {
  category: string
  hasAttachments: boolean
  attachmentHints: string[]
  descriptionKeywords: string[]
  estimatedComplexity: number // 1-10
}

// ── Per-category default tier & fallback manifests ───────────────────────

interface CategoryRule {
  tier: ChallengeTier
  /** Manifests recommended by default for this category. */
  defaultManifests: string[]
  /** Description keywords that lower the tier (make it faster to solve). */
  fastKeywords: string[]
  /** Description keywords that raise the tier (make it harder). */
  heavyKeywords: string[]
}

/**
 * Category tier rules ordered from easiest → hardest.
 * A challenge that matches a `fastKeyword` gets the fast tier even if the
 * category default is medium.  A `heavyKeyword` overrides all the way to
 * heavy.
 */
const CATEGORY_RULES: Record<string, CategoryRule> = {
  encoding: {
    tier: 'fast',
    defaultManifests: ['ciphey', 'cipher-identifier'],
    fastKeywords: [
      'base64',
      'hex',
      'rot13',
      'caesar',
      'morse',
      'binary',
      'ascii',
      'utf',
      'encode',
      'decode',
      'convert',
      'substitution',
      'a1z26',
      'atbash',
      'vigenere',
      'xor',
      'rail fence',
    ],
    heavyKeywords: ['rsa', 'aes', 'elliptic', 'ecc', 'paillier', 'lattice'],
  },
  crypto: {
    tier: 'medium',
    defaultManifests: ['ciphey', 'cipher-identifier', 'rsactftool'],
    fastKeywords: [
      'base64',
      'hex',
      'rot13',
      'caesar',
      'morse',
      'substitution',
      'a1z26',
      'atbash',
      'vigenere',
    ],
    heavyKeywords: ['rsa', 'aes', 'elliptic', 'ecc', 'side-channel', 'padding oracle'],
  },
  misc: {
    tier: 'fast',
    defaultManifests: ['strings', 'file'],
    fastKeywords: [
      'strings',
      'grep',
      'find',
      'flag',
      'cat',
      'read',
      'text',
      'plaintext',
      'obfuscated',
      'sanitty',
    ],
    heavyKeywords: ['binary', 'compile', 'reverse', 'exploit', 'memory', 'corrupt'],
  },
  forensics: {
    tier: 'medium',
    defaultManifests: ['file', 'strings', 'binwalk', 'exiftool', 'zsteg'],
    fastKeywords: [
      'png',
      'jpeg',
      'jpg',
      'gif',
      'bmp',
      'image',
      'picture',
      'photo',
      'exif',
      'metadata',
      'stego',
      'lsb',
      'hidden',
      'embedded',
    ],
    heavyKeywords: ['memory dump', 'disk image', 'registry', 'timeline', 'log analysis'],
  },
  reverse: {
    tier: 'heavy',
    defaultManifests: ['file', 'strings', 'capa'],
    fastKeywords: ['java', 'python', '.pyc', 'decompile', 'jar', 'apk'],
    heavyKeywords: ['obfuscated', 'packed', 'vm', 'virtualized', 'custom'],
  },
  rev: {
    tier: 'heavy',
    defaultManifests: ['file', 'strings', 'capa'],
    fastKeywords: ['java', 'python', '.pyc', 'decompile', 'jar', 'apk'],
    heavyKeywords: ['obfuscated', 'packed', 'vm', 'virtualized', 'custom'],
  },
  pwn: {
    tier: 'heavy',
    defaultManifests: ['file', 'pwntools-checksec'],
    fastKeywords: [],
    heavyKeywords: [
      'rop',
      'shellcode',
      'buffer overflow',
      'format string',
      'heap',
      'use after free',
      'kernel',
    ],
  },
  web: {
    tier: 'heavy',
    defaultManifests: ['nuclei'],
    fastKeywords: ['robots.txt', 'source', 'view-source', 'inspect', 'cookie'],
    heavyKeywords: ['sql injection', 'xss', 'csrf', 'ssrf', 'rce', 'deserialization', 'jwt'],
  },
  traffic: {
    tier: 'medium',
    defaultManifests: ['strings', 'nmap'],
    fastKeywords: [
      'pcap',
      'pcapng',
      'wireshark',
      'tshark',
      'tcp',
      'http',
      'dns',
      'packet',
      'capture',
      'follow tcp',
      'follow stream',
    ],
    heavyKeywords: ['tls', 'ssl', 'encrypted', '802.11', 'bluetooth', 'usb'],
  },
  pcap: {
    tier: 'medium',
    defaultManifests: ['strings', 'nmap'],
    fastKeywords: ['pcap', 'pcapng', 'wireshark', 'tshark', 'tcp', 'http', 'packet'],
    heavyKeywords: ['tls', 'ssl', 'encrypted'],
  },
}

const DEFAULT_RULE: CategoryRule = {
  tier: 'medium',
  defaultManifests: ['file', 'strings'],
  fastKeywords: ['base64', 'hex', 'text', 'flag', 'simple', 'easy', 'trivial'],
  heavyKeywords: ['binary', 'exploit', 'reverse', 'obscure', 'complex'],
}

// ── Classifier ────────────────────────────────────────────────────────────

export class ChallengeClassifier {
  private catalog: OneShotCatalog

  constructor(catalog: OneShotCatalog) {
    this.catalog = catalog
  }

  /**
   * Classify a single challenge.  Pure function of challenge metadata —
   * makes zero LLM calls, zero I/O beyond catalog lookups.
   */
  classify(challenge: QueuedChallenge): ClassificationResult {
    const category = (challenge.category ?? 'misc').toLowerCase()
    const description = (challenge.description ?? challenge.title ?? '').toLowerCase()
    const attachmentHints = challenge.inputArtifactPaths ?? []

    const rule = CATEGORY_RULES[category] ?? DEFAULT_RULE

    // Extract description keywords
    const descriptionKeywords = this.extractKeywords(description, rule)

    // Determine tier
    let tier = rule.tier

    const isFast = rule.fastKeywords.some((kw) => description.includes(kw.toLowerCase()))
    const isHeavy = rule.heavyKeywords.some((kw) => description.includes(kw.toLowerCase()))

    if (isHeavy && tier !== 'heavy') {
      tier = 'heavy'
    } else if (isFast && tier === 'medium') {
      tier = 'fast'
    } else if (isFast && tier === 'heavy') {
      tier = 'medium'
    }

    // Estimate complexity (1-10)
    const estimatedComplexity = this.estimateComplexity(tier, descriptionKeywords, rule)

    // Resolve recommended manifests (filter to what's actually registered)
    const recommendedManifests = this.resolveManifests(rule.defaultManifests, category)

    const confidence =
      tier === 'fast' && descriptionKeywords.length >= 2
        ? 0.9
        : tier === 'fast'
          ? 0.8
          : tier === 'medium'
            ? 0.7
            : 0.6

    return {
      tier,
      confidence,
      recommendedManifests,
      features: {
        category,
        hasAttachments: attachmentHints.length > 0,
        attachmentHints,
        descriptionKeywords,
        estimatedComplexity,
      },
    }
  }

  // ── Private helpers ──────────────────────────────────────────────────

  private extractKeywords(description: string, rule: CategoryRule): string[] {
    const all = [...rule.fastKeywords, ...rule.heavyKeywords]
    const found: string[] = []
    for (const kw of all) {
      if (description.includes(kw.toLowerCase())) {
        found.push(kw)
      }
    }
    return found
  }

  private resolveManifests(defaultIds: string[], _category: string): string[] {
    // Start with category-specific defaults
    const ids = new Set(defaultIds)
    // Always include `file` and `strings` as universal fallbacks
    ids.add('file')
    ids.add('strings')
    // Filter to manifests that actually exist in the catalog
    return [...ids].filter((id) => this.catalog.get(id) !== undefined)
  }

  private estimateComplexity(tier: ChallengeTier, keywords: string[], rule: CategoryRule): number {
    const base: Record<ChallengeTier, number> = { fast: 1, medium: 4, heavy: 7 }

    let score = base[tier]

    // Heavy keywords increase complexity
    const heavyMatches = keywords.filter((k) => rule.heavyKeywords.includes(k)).length
    score += Math.min(heavyMatches, 3) // cap at +3

    // Fast keywords decrease complexity
    const fastMatches = keywords.filter((k) => rule.fastKeywords.includes(k)).length
    score -= Math.min(fastMatches, 2) // cap at -2

    return Math.max(1, Math.min(10, score))
  }
}

/**
 * Create a classifier backed by the global oneshot catalog.
 */
export function createChallengeClassifier(catalog: OneShotCatalog): ChallengeClassifier {
  return new ChallengeClassifier(catalog)
}
