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
    inputMatchers: {
      taskTags: ['rsa', 'cipher', 'modulus', 'n=', 'e=', 'public exponent', 'wiener'],
      taskCategories: ['crypto'],
    },
    runner: {
      type: 'process',
      command: [
        'python3',
        'oneshot/scripts/crypto_rsa_small_e.py',
        '--n',
        '${n}',
        '--e',
        '${e}',
        '--c',
        '${c}',
      ],
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
    inputMatchers: {
      taskTags: [
        'encoding',
        'cipher',
        'base64',
        'decode',
        'encoded',
        'rot13',
        'hex',
        'base32',
        'base85',
      ],
      taskCategories: ['crypto'],
    },
    runner: {
      type: 'process',
      command: ['python3', 'oneshot/scripts/crypto_cipher_cascade.py', '--input', '${encoded}'],
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
    inputMatchers: {
      extensions: ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.tiff', '.webp', '.tif'],
      mimeTypes: ['image/'],
      taskTags: ['image', 'photo', 'picture', 'stego', 'exif', 'metadata'],
    },
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
    inputMatchers: {
      extensions: ['.exe', '.dll', '.so', '.bin', '.out', '.o', '.class'],
      taskTags: ['binary', 'reverse', 'executable', 'elf', 'pe', 'compiled'],
    },
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
    inputMatchers: {
      taskTags: ['web', 'http', 'url', 'website', 'endpoint', 'server'],
      taskCategories: ['web'],
    },
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
  {
    id: 'stego-lsb-extract',
    displayName: 'Image LSB Steganography Extractor',
    category: 'forensics',
    description:
      'Extracts LSB-hidden data from PNG/BMP images across all RGB channels and bit-planes.',
    source: {
      repository: 'https://github.com/ovogogogo/agent_CTF',
    },
    maturity: 'stable',
    enabledByDefault: true,
    allowedProfiles: ['forensics', 'image-stego', 'default'],
    inputMatchers: {
      extensions: ['.png', '.bmp'],
      mimeTypes: ['image/png', 'image/bmp'],
      taskTags: ['stego', 'lsb', 'hidden', 'steganography', 'image'],
    },
    runner: {
      type: 'process',
      command: ['python3', 'oneshot/scripts/image_stego_lsb.py', '--file', '${filePath}'],
    },
    resources: {
      timeoutSeconds: 30,
      maxOutputBytes: 50000,
    },
    network: {
      mode: 'none',
      requiresScopeApproval: false,
    },
    output: {
      parser: 'regex',
      flagPatterns: ['(flag\\{[^}]+\\}|CTF\\{[^}]+\\}|DASCTF\\{[^}]+\\}|XHLJ\\{[^}]+\\})'],
    },
    scheduling: {
      costTier: 'medium',
      falsePositiveRisk: 'medium',
    },
  },
  {
    id: 'general-flag-extract',
    displayName: 'General Flag Pattern Scanner',
    category: 'forensics',
    description: 'Scans files or text for 15+ CTF flag patterns including Chinese CTF formats.',
    source: {
      repository: 'https://github.com/ovogogogo/agent_CTF',
    },
    maturity: 'stable',
    enabledByDefault: true,
    allowedProfiles: ['forensics', 'reverse', 'default'],
    inputMatchers: {
      extensions: [
        '.txt',
        '.png',
        '.jpg',
        '.jpeg',
        '.gif',
        '.bmp',
        '.bin',
        '.zip',
        '.pcap',
        '.pcapng',
      ],
      taskTags: ['flag', 'forensics', 'file', 'attachment', 'download'],
    },
    runner: {
      type: 'process',
      command: ['python3', 'oneshot/scripts/general_strings_flag.py', '--file', '${filePath}'],
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
      flagPatterns: [
        '(flag\\{[^}]+\\}|CTF\\{[^}]+\\}|DASCTF\\{[^}]+\\}|XHLJ\\{[^}]+\\}|key\\{[^}]+\\})',
      ],
    },
    scheduling: {
      costTier: 'fast',
      falsePositiveRisk: 'low',
    },
  },
  {
    id: 'forensics-binwalk-extract',
    displayName: 'Binwalk Forensics Extractor',
    category: 'forensics',
    description:
      'Runs binwalk to extract embedded files and recursively searches for flag patterns.',
    source: {
      repository: 'https://github.com/ovogogogo/agent_CTF',
    },
    maturity: 'stable',
    enabledByDefault: true,
    allowedProfiles: ['forensics', 'default'],
    inputMatchers: {
      extensions: ['.bin', '.img', '.fw', '.rom', '.dump', '.raw', '.ubi', '.squashfs'],
      taskTags: ['firmware', 'embedded', 'binwalk', 'extract', 'carve'],
    },
    runner: {
      type: 'process',
      command: ['python3', 'oneshot/scripts/forensics_binwalk_extract.py', '--file', '${filePath}'],
    },
    resources: {
      timeoutSeconds: 60,
      maxOutputBytes: 100000,
    },
    network: {
      mode: 'none',
      requiresScopeApproval: false,
    },
    output: {
      parser: 'regex',
      flagPatterns: [
        '(flag\\{[^}]+\\}|CTF\\{[^}]+\\}|DASCTF\\{[^}]+\\}|XHLJ\\{[^}]+\\}|key\\{[^}]+\\})',
      ],
    },
    scheduling: {
      costTier: 'medium',
      falsePositiveRisk: 'low',
    },
  },
  {
    id: 'classical-cipher-sweep',
    displayName: 'Classical Cipher Sweep',
    category: 'crypto',
    description:
      'Instantly tries all common classical ciphers: ROT1-25, Atbash, Vigenere, Bacon, Rail Fence, Morse, A1Z26.',
    source: {
      repository: 'https://github.com/ovogogogo/agent_CTF',
    },
    maturity: 'stable',
    enabledByDefault: true,
    allowedProfiles: ['crypto', 'encoding', 'default'],
    inputMatchers: {
      taskTags: [
        'cipher',
        'classical',
        'decrypt',
        'decode',
        'rot',
        'caesar',
        'substitution',
        'vigenere',
        'atbash',
        'morse',
      ],
      taskCategories: ['crypto', 'encoding'],
    },
    runner: {
      type: 'process',
      command: ['python3', 'oneshot/scripts/classical_cipher_sweep.py', '--input', '${input}'],
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
      flagPatterns: ['(flag\\{[^}]+\\}|CTF\\{[^}]+\\}|picoCTF\\{[^}]+\\})'],
    },
    scheduling: {
      costTier: 'fast',
      falsePositiveRisk: 'low',
    },
  },
  {
    id: 'xor-bruteforce',
    displayName: 'XOR Bruteforce Solver',
    category: 'crypto',
    description: 'Bruteforces single-byte and multi-byte XOR keys with English frequency scoring.',
    source: {
      repository: 'https://github.com/ovogogogo/agent_CTF',
    },
    maturity: 'stable',
    enabledByDefault: true,
    allowedProfiles: ['crypto', 'reverse', 'default'],
    inputMatchers: {
      taskTags: ['xor', 'xored', 'exclusive', 'byte', 'key', 'encrypted'],
      taskCategories: ['crypto', 'reverse'],
    },
    runner: {
      type: 'process',
      command: ['python3', 'oneshot/scripts/xor_bruteforce.py', '--hex', '${hex}'],
    },
    resources: {
      timeoutSeconds: 15,
      maxOutputBytes: 50000,
    },
    network: {
      mode: 'none',
      requiresScopeApproval: false,
    },
    output: {
      parser: 'regex',
      flagPatterns: ['(flag\\{[^}]+\\}|CTF\\{[^}]+\\}|picoCTF\\{[^}]+\\})'],
    },
    scheduling: {
      costTier: 'fast',
      falsePositiveRisk: 'medium',
    },
  },
  {
    id: 'archive-recursive',
    displayName: 'Archive Recursive Extractor',
    category: 'forensics',
    description:
      'Recursively extracts nested archives (zip in zip in tar, etc.) and searches for flags.',
    source: {
      repository: 'https://github.com/ovogogogo/agent_CTF',
    },
    maturity: 'stable',
    enabledByDefault: true,
    allowedProfiles: ['forensics', 'file-forensics', 'default'],
    inputMatchers: {
      extensions: ['.zip', '.tar', '.gz', '.bz2', '.xz', '.7z', '.rar', '.jar'],
      taskTags: ['archive', 'zip', 'nested', 'matryoshka', 'dolls', 'extract', 'compress'],
      taskCategories: ['forensics'],
    },
    runner: {
      type: 'process',
      command: ['python3', 'oneshot/scripts/archive_recursive.py', '--file', '${filePath}'],
    },
    resources: {
      timeoutSeconds: 60,
      maxOutputBytes: 100000,
    },
    network: {
      mode: 'none',
      requiresScopeApproval: false,
    },
    output: {
      parser: 'regex',
      flagPatterns: ['(flag\\{[^}]+\\}|CTF\\{[^}]+\\}|picoCTF\\{[^}]+\\})'],
    },
    scheduling: {
      costTier: 'medium',
      falsePositiveRisk: 'low',
    },
  },
]
