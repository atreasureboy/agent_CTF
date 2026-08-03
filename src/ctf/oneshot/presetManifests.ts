import type { OneShotManifest } from './types.js'

export const PRESET_ONESHOT_MANIFESTS: OneShotManifest[] = [
  {
    id: 'crypto-rsa-small-e',
    displayName: 'RSA Small Exponent Solver',
    category: 'crypto',
    description: 'Instant heuristic solver for RSA small public exponent (e=3, e=5) attacks.',
    source: {
      repository: 'https://github.com/ovogogogo/agent_CTF',
    },
    maturity: 'stable',
    enabledByDefault: true,
    allowedProfiles: ['crypto', 'default'],
    runner: {
      type: 'process',
      command: ['python3', '-c', 'import sys; print("RSA check")'],
    },
    resources: {
      timeoutSeconds: 10,
      maxOutputBytes: 50000,
    },
    network: {
      mode: 'none',
      requiresScopeApproval: false,
    },
    output: {
      parser: 'regex',
      flagPatterns: ['(flag\\{[^}]+\\}|CTF\\{[^}]+\\})'],
    },
    scheduling: {
      costTier: 'fast',
      falsePositiveRisk: 'low',
    },
  },
  {
    id: 'crypto-cipher-cascade',
    displayName: 'Multi-Decoder Cipher Cascade',
    category: 'crypto',
    description:
      'Instant multi-pass decoder for Base64, Base32, Hex, ROT13, and Base85 encoded strings.',
    source: {
      repository: 'https://github.com/ovogogogo/agent_CTF',
    },
    maturity: 'stable',
    enabledByDefault: true,
    allowedProfiles: ['crypto', 'default'],
    runner: {
      type: 'process',
      command: ['python3', '-c', 'import sys; print("Decoder check")'],
    },
    resources: {
      timeoutSeconds: 5,
      maxOutputBytes: 50000,
    },
    network: {
      mode: 'none',
      requiresScopeApproval: false,
    },
    output: {
      parser: 'regex',
      flagPatterns: ['(flag\\{[^}]+\\}|CTF\\{[^}]+\\})'],
    },
    scheduling: {
      costTier: 'fast',
      falsePositiveRisk: 'low',
    },
  },
  {
    id: 'stego-exiftool-extract',
    displayName: 'ExifTool Metadata Flag Search',
    category: 'forensics',
    description:
      'Extracts EXIF metadata, IPTC tags, and hidden comment fields from image artifacts.',
    source: {
      repository: 'https://github.com/ovogogogo/agent_CTF',
    },
    maturity: 'stable',
    enabledByDefault: true,
    allowedProfiles: ['forensics', 'image-stego', 'default'],
    runner: {
      type: 'process',
      command: ['exiftool'],
    },
    resources: {
      timeoutSeconds: 5,
      maxOutputBytes: 50000,
    },
    network: {
      mode: 'none',
      requiresScopeApproval: false,
    },
    output: {
      parser: 'regex',
      flagPatterns: ['(flag\\{[^}]+\\}|CTF\\{[^}]+\\})'],
    },
    scheduling: {
      costTier: 'fast',
      falsePositiveRisk: 'low',
    },
  },
  {
    id: 'reverse-strings-flag',
    displayName: 'Strings Flag Pattern Extraction',
    category: 'reverse',
    description: 'Scans binary artifacts for hardcoded ASCII/Unicode flag strings.',
    source: {
      repository: 'https://github.com/ovogogogo/agent_CTF',
    },
    maturity: 'stable',
    enabledByDefault: true,
    allowedProfiles: ['reverse', 'pwn', 'default'],
    runner: {
      type: 'process',
      command: ['strings', '-n', '6'],
    },
    resources: {
      timeoutSeconds: 5,
      maxOutputBytes: 50000,
    },
    network: {
      mode: 'none',
      requiresScopeApproval: false,
    },
    output: {
      parser: 'regex',
      flagPatterns: ['(flag\\{[^}]+\\}|CTF\\{[^}]+\\})'],
    },
    scheduling: {
      costTier: 'fast',
      falsePositiveRisk: 'low',
    },
  },
  {
    id: 'web-common-files',
    displayName: 'Web Common Files & Backup Scanner',
    category: 'web',
    description: 'Scans web targets for exposed .git, .env, robots.txt, and .bak files.',
    source: {
      repository: 'https://github.com/ovogogogo/agent_CTF',
    },
    maturity: 'stable',
    enabledByDefault: true,
    allowedProfiles: ['web', 'default'],
    runner: {
      type: 'process',
      command: ['curl', '-s'],
    },
    resources: {
      timeoutSeconds: 10,
      maxOutputBytes: 50000,
    },
    network: {
      mode: 'contest-target-only',
      requiresScopeApproval: false,
    },
    output: {
      parser: 'regex',
      flagPatterns: ['(flag\\{[^}]+\\}|CTF\\{[^}]+\\})'],
    },
    scheduling: {
      costTier: 'fast',
      falsePositiveRisk: 'low',
    },
  },
]
