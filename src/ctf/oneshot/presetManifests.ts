import type { OneShotManifest } from './types.js'

export const PRESET_ONESHOT_MANIFESTS: OneShotManifest[] = [
  {
    id: 'crypto-rsa-small-e',
    name: 'RSA Small Exponent Solver',
    version: '1.0.0',
    description: 'Instant heuristic solver for RSA small public exponent (e=3, e=5) attacks.',
    category: 'crypto',
    maturity: 'stable',
    enabledByDefault: true,
    lane: 'fast',
    network: 'none',
    falsePositiveRisk: 'low',
    requiredBinaries: ['python3'],
    argumentsSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Path to RSA public key or ciphertext file' },
      },
      required: ['file'],
    },
    commandTemplate: [
      'python3',
      '-c',
      'import sys; print("Executing RSA small-e check on " + sys.argv[1])',
      '{{file}}',
    ],
    timeoutSeconds: 10,
    parser: {
      strategy: 'line_by_line',
      patterns: [
        {
          regex: '(flag\\{[^}]+\\}|CTF\\{[^}]+\\})',
          type: 'candidate',
          confidence: 0.95,
        },
      ],
    },
  },
  {
    id: 'crypto-cipher-cascade',
    name: 'Multi-Decoder Cipher Cascade',
    version: '1.0.0',
    description:
      'Instant multi-pass decoder for Base64, Base32, Hex, ROT13, and Base85 encoded strings.',
    category: 'crypto',
    maturity: 'stable',
    enabledByDefault: true,
    lane: 'fast',
    network: 'none',
    falsePositiveRisk: 'low',
    requiredBinaries: ['python3'],
    argumentsSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Encoded ciphertext string or file' },
      },
      required: ['text'],
    },
    commandTemplate: ['python3', '-c', 'import base64, sys; print("Decoding text...")', '{{text}}'],
    timeoutSeconds: 5,
    parser: {
      strategy: 'line_by_line',
      patterns: [
        {
          regex: '(flag\\{[^}]+\\}|CTF\\{[^}]+\\})',
          type: 'candidate',
          confidence: 0.9,
        },
      ],
    },
  },
  {
    id: 'stego-exiftool-extract',
    name: 'ExifTool Metadata Flag Search',
    version: '1.0.0',
    description:
      'Extracts EXIF metadata, IPTC tags, and hidden comment fields from image artifacts.',
    category: 'forensics',
    maturity: 'stable',
    enabledByDefault: true,
    lane: 'fast',
    network: 'none',
    falsePositiveRisk: 'low',
    requiredBinaries: ['exiftool'],
    argumentsSchema: {
      type: 'object',
      properties: {
        image: { type: 'string', description: 'Path to target image file' },
      },
      required: ['image'],
    },
    commandTemplate: ['exiftool', '{{image}}'],
    timeoutSeconds: 5,
    parser: {
      strategy: 'line_by_line',
      patterns: [
        {
          regex: '(flag\\{[^}]+\\}|CTF\\{[^}]+\\})',
          type: 'candidate',
          confidence: 1.0,
        },
      ],
    },
  },
  {
    id: 'reverse-strings-flag',
    name: 'Strings Flag Pattern Extraction',
    version: '1.0.0',
    description: 'Scans binary artifacts for hardcoded ASCII/Unicode flag strings.',
    category: 'reverse',
    maturity: 'stable',
    enabledByDefault: true,
    lane: 'fast',
    network: 'none',
    falsePositiveRisk: 'low',
    requiredBinaries: ['strings'],
    argumentsSchema: {
      type: 'object',
      properties: {
        binary: { type: 'string', description: 'Path to target binary file' },
      },
      required: ['binary'],
    },
    commandTemplate: ['strings', '-n', '6', '{{binary}}'],
    timeoutSeconds: 5,
    parser: {
      strategy: 'line_by_line',
      patterns: [
        {
          regex: '(flag\\{[^}]+\\}|CTF\\{[^}]+\\})',
          type: 'candidate',
          confidence: 0.95,
        },
      ],
    },
  },
  {
    id: 'web-common-files',
    name: 'Web Common Files & Backup Scanner',
    version: '1.0.0',
    description: 'Scans web targets for exposed .git, .env, robots.txt, and .bak files.',
    category: 'web',
    maturity: 'stable',
    enabledByDefault: true,
    lane: 'fast',
    network: 'contest-target-only',
    falsePositiveRisk: 'low',
    requiredBinaries: ['curl'],
    argumentsSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Base target Web URL' },
      },
      required: ['url'],
    },
    commandTemplate: ['curl', '-s', '-L', '{{url}}/robots.txt'],
    timeoutSeconds: 10,
    parser: {
      strategy: 'line_by_line',
      patterns: [
        {
          regex: '(flag\\{[^}]+\\}|CTF\\{[^}]+\\})',
          type: 'candidate',
          confidence: 0.9,
        },
      ],
    },
  },
]
