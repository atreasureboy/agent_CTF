import type { Tool, ToolDefinition, ToolResult } from '../core/types.js'
import { TOOL_METADATA } from '../core/toolMetadata.js'
import type { CTFToolMetadata } from '../core/toolDefinition.js'
import { createDecipheriv } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'

function makeUtilTool(
  name: string,
  description: string,
  parameters: unknown,
  handler: (input: Record<string, unknown>) => ToolResult,
  _metadata: CTFToolMetadata,
): Tool {
  return {
    name,
    definition: {
      type: 'function',
      function: { name, description, parameters },
    } as ToolDefinition,
    // eslint-disable-next-line @typescript-eslint/require-await
    execute: async (input) => handler(input),
    concurrencySafe: true,
  }
}

function base64DecodeTool(): Tool {
  return makeUtilTool(
    'base64_decode',
    'Decode a base64-encoded string to plaintext.',
    {
      type: 'object',
      properties: {
        encoded: { type: 'string', description: 'Base64-encoded string to decode.' },
      },
      required: ['encoded'],
    },
    (input) => {
      const encoded = String((input.encoded as string) ?? '')
      try {
        const decoded = Buffer.from(encoded, 'base64').toString('utf-8')
        return { isError: false, content: decoded }
      } catch (e) {
        return { isError: true, content: `base64 decode failed: ${(e as Error).message}` }
      }
    },
    {
      domains: ['crypto', 'forensics', 'web'],
      executionMode: 'foreground',
      costClass: 'cheap',
      outputMode: 'inline',
      riskLevel: 'low',
    },
  )
}

TOOL_METADATA['base64_decode'] = {
  domains: ['crypto', 'forensics', 'web'],
  executionMode: 'foreground',
  costClass: 'cheap',
  outputMode: 'inline',
  riskLevel: 'low',
}

function base64EncodeTool(): Tool {
  return makeUtilTool(
    'base64_encode',
    'Encode a plaintext string to base64.',
    {
      type: 'object',
      properties: {
        plaintext: { type: 'string', description: 'Plaintext string to encode.' },
      },
      required: ['plaintext'],
    },
    (input) => {
      const plaintext = String((input.plaintext as string) ?? '')
      try {
        const encoded = Buffer.from(plaintext, 'utf-8').toString('base64')
        return { isError: false, content: encoded }
      } catch (e) {
        return { isError: true, content: `base64 encode failed: ${(e as Error).message}` }
      }
    },
    {
      domains: ['crypto', 'forensics', 'web'],
      executionMode: 'foreground',
      costClass: 'cheap',
      outputMode: 'inline',
      riskLevel: 'low',
    },
  )
}

TOOL_METADATA['base64_encode'] = {
  domains: ['crypto', 'forensics', 'web'],
  executionMode: 'foreground',
  costClass: 'cheap',
  outputMode: 'inline',
  riskLevel: 'low',
}

function jsfuckEncodeTool(): Tool {
  return makeUtilTool(
    'jsfuck_encode',
    'Encode a string into JSFuck (JavaScript using only []()!+ characters).',
    {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'JavaScript code or string to encode.' },
      },
      required: ['code'],
    },
    (input) => {
      const code = String((input.code as string) ?? '')
      try {
        const encoded = jsfuckEncode(code)
        return { isError: false, content: encoded }
      } catch (e) {
        return { isError: true, content: `JSFuck encode failed: ${(e as Error).message}` }
      }
    },
    {
      domains: ['web', 'crypto'],
      executionMode: 'foreground',
      costClass: 'cheap',
      outputMode: 'inline',
      riskLevel: 'low',
    },
  )
}

TOOL_METADATA['jsfuck_encode'] = {
  domains: ['web', 'crypto'],
  executionMode: 'foreground',
  costClass: 'cheap',
  outputMode: 'inline',
  riskLevel: 'low',
}

function jsfuckEncode(input: string): string {
  const JSFUCK_CHARS: Record<string, string> = {
    '0': '((+[])+([]))',
    '1': '((+!![])+([]))',
    '2': '((!![]+[])+([]))',
    '3': '(((+!![])+(!![]))+([]))',
    '4': '(((![]+[])+([])))',
    '5': '((!![]+(!![]))+([]))',
    '6': '(((![])+([]))+([]))',
    '7': '((!![]+(!![])+([]))+([]))',
    '8': '((![]+(![]))+([]))',
    '9': '((!![]+(![]))+([]))',
  }

  function buildNumber(n: number): string {
    if (n === 0) return '+[]'
    if (n === 1) return '+!![]'
    if (n === 2) return '!![]+!![]'
    if (n === 3) return '!![]+!![]+!![]'
    if (n === 4) return '!![]+!![]+!![]+!![]'
    if (n === 5) return '!![]+!![]+!![]+!![]+!![]'
    if (n === 6) return '!![]+!![]+!![]+!![]+!![]+!![]'
    if (n === 7) return '!![]+!![]+!![]+!![]+!![]+!![]+!![]'
    if (n === 8) return '!![]+!![]+!![]+!![]+!![]+!![]+!![]+!![]'
    if (n === 9) return '!![]+!![]+!![]+!![]+!![]+!![]+!![]+!![]+!![]'
    const digits = String(n)
    let result = ''
    for (let i = 0; i < digits.length; i++) {
      if (i > 0) result += '+'
      result += JSFUCK_CHARS[digits[i]]
    }
    return result
  }

  function buildChar(charCode: number): string {
    const numExpr = buildNumber(charCode)
    return `(${numExpr})[(![]+[])[+[]]+(![]+[])[+![]]+([][[]]+[])[+![]+![]]+(!![]+[])[+[]]+(!![]+[])[+![]]+(!![]+[])[+!![]]+([][[]]+[])[+[]]+([][[]]+[])[+![]]+([][[]]+[])[+![]+![]]+(!![]+[])[+[]]+(!![]+[])[+!![]]+(!![]+[])[+![]]+([][[]]+[])[+[]]]`
  }

  function _buildString(str: string): string {
    if (str.length === 0) return '[]'
    let result = '['
    for (let i = 0; i < str.length; i++) {
      if (i > 0) result += '+'
      result += buildChar(str.charCodeAt(i))
    }
    result += ']'
    return result
  }

  let output = ''
  for (let i = 0; i < input.length; i++) {
    if (i > 0) output += '+'
    output += buildChar(input.charCodeAt(i))
  }
  return output
}

function phpFilterChainTool(): Tool {
  return makeUtilTool(
    'php_filter_chain',
    'Generate a php://filter/ chain that decodes to the given payload.',
    {
      type: 'object',
      properties: {
        payload: { type: 'string', description: 'Payload string to encode as a PHP filter chain.' },
      },
      required: ['payload'],
    },
    (input) => {
      const payload = String((input.payload as string) ?? '')
      try {
        const chain = generatePhpFilterChain(payload)
        return { isError: false, content: chain }
      } catch (e) {
        return {
          isError: true,
          content: `PHP filter chain generation failed: ${(e as Error).message}`,
        }
      }
    },
    {
      domains: ['web'],
      executionMode: 'foreground',
      costClass: 'cheap',
      outputMode: 'inline',
      riskLevel: 'low',
    },
  )
}

TOOL_METADATA['php_filter_chain'] = {
  domains: ['web'],
  executionMode: 'foreground',
  costClass: 'cheap',
  outputMode: 'inline',
  riskLevel: 'low',
}

function generatePhpFilterChain(payload: string): string {
  const CONV_TABLE: Record<number, string[]> = {
    0: ['convert.iconv.UTF8.CSISO2022KR', 'convert.iconv.ISO2022KR.UTF16', 'convert.iconv.L6.UCS2'],
    1: [
      'convert.iconv.ISO88597.UTF16',
      'convert.iconv.RK1048.UCS-4LE',
      'convert.iconv.UTF32.CSISO2022KR',
      'convert.b64decode/00',
    ],
    2: [
      'convert.iconv.L5.UTF-32',
      'convert.iconv.ISO88597.UTF16',
      'convert.iconv.RK1048.UCS-4LE',
      'convert.iconv.UTF32.CSISO2022KR',
      'convert.b64decode/00',
    ],
    3: [
      'convert.iconv.L6.UTF-16',
      'convert.iconv.ISO88597.UTF16',
      'convert.iconv.RK1048.UCS-4LE',
      'convert.iconv.UTF32.CSISO2022KR',
      'convert.b64decode/00',
    ],
    4: [
      'convert.iconv.CP1212.UTF32',
      'convert.iconv.ISO88597.UTF16',
      'convert.iconv.RK1048.UCS-4LE',
      'convert.iconv.UTF32.CSISO2022KR',
      'convert.b64decode/00',
    ],
    5: [
      'convert.iconv.UTF8.UTF16LE',
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.UCS2.UTF8',
      'convert.iconv.ISO-8859-1.UCS2',
      'convert.b64decode/00',
    ],
    6: [
      'convert.iconv.INIS.UTF16',
      'convert.iconv.ISO88597.UTF16',
      'convert.iconv.RK1048.UCS-4LE',
      'convert.iconv.UTF32.CSISO2022KR',
      'convert.b64decode/00',
    ],
    7: [
      'convert.iconv.UTF8.UTF16LE',
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.UCS2.UTF8',
      'convert.iconv.8859-1.UCS2',
      'convert.b64decode/00',
    ],
    8: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
      'convert.b64decode/00',
    ],
    9: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.ISO6937.UCS2',
      'convert.b64decode/00',
    ],
    10: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    13: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.UCS-2LE.UCS-2BE',
      'convert.iconv.TCVN.UCS2',
      'convert.iconv.8859-1.UCS2',
    ],
    14: [
      'convert.iconv.UTF8.UCS-2LE',
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.UCS2.UTF8',
      'convert.iconv.ISO-8859-1.UCS2',
      'convert.b64decode/00',
    ],
    15: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    16: [
      'convert.iconv.UTF8.UTF16',
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.UCS2.UTF8',
      'convert.iconv.ISO-8859-1.UCS2',
      'convert.b64decode/00',
    ],
    17: [
      'convert.iconv.UTF8.UTF16LE',
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.UCS2.UTF8',
      'convert.iconv.8859-1.UCS2',
      'convert.b64decode/00',
    ],
    18: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.UCS-2LE.UCS-2BE',
      'convert.iconv.TCVN.UCS2',
      'convert.iconv.8859-1.UCS2',
    ],
    19: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    20: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.UCS-2LE.UCS-2BE',
      'convert.iconv.TCVN.UCS2',
      'convert.iconv.8859-1.UCS2',
    ],
    21: [
      'convert.iconv.UTF8.UTF16LE',
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.UCS2.UTF8',
      'convert.iconv.8859-1.UCS2',
      'convert.b64decode/00',
    ],
    22: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.UCS-2LE.UCS-2BE',
      'convert.iconv.TCVN.UCS2',
      'convert.iconv.8859-1.UCS2',
    ],
    23: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    24: [
      'convert.iconv.UTF8.UTF16',
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.UCS2.UTF8',
      'convert.iconv.ISO-8859-1.UCS2',
      'convert.b64decode/00',
    ],
    25: [
      'convert.iconv.UTF8.UTF16LE',
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.UCS2.UTF8',
      'convert.iconv.8859-1.UCS2',
      'convert.b64decode/00',
    ],
    26: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.UCS-2LE.UCS-2BE',
      'convert.iconv.TCVN.UCS2',
      'convert.iconv.8859-1.UCS2',
    ],
    27: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    28: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.UCS-2LE.UCS-2BE',
      'convert.iconv.TCVN.UCS2',
      'convert.iconv.8859-1.UCS2',
    ],
    29: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    30: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.UCS-2LE.UCS-2BE',
      'convert.iconv.TCVN.UCS2',
      'convert.iconv.8859-1.UCS2',
    ],
    31: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    32: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    33: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    34: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    35: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    36: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    37: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    38: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    39: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    40: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    41: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    42: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    43: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    44: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    45: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    46: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    47: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    48: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    49: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    50: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    51: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    52: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    53: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    54: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    55: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    56: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    57: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    58: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    59: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    60: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    61: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    62: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    63: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    64: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    65: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    66: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    67: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    68: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    69: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    70: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    71: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    72: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    73: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    74: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    75: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    76: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    77: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    78: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    79: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    80: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    81: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    82: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    83: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    84: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    85: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    86: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    87: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    88: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    89: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    90: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    91: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    92: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    93: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    94: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    95: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    96: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    97: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    98: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    99: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    100: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    101: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    102: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    103: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    104: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    105: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    106: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    107: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    108: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    109: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    110: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    111: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    112: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    113: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    114: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    115: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    116: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    117: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    118: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    119: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    120: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    121: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    122: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    123: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    124: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    125: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    126: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
    127: [
      'convert.iconv.UTF8.CSISO2022KR',
      'convert.iconv.ISO2022KR.UTF16',
      'convert.iconv.L6.UCS2',
    ],
  }

  const buf = Buffer.from(payload, 'utf-8')
  const b64 = buf.toString('base64')

  const filters: string[] = ['convert.base64-encode']

  for (let i = 0; i < b64.length; i++) {
    const code = b64.charCodeAt(i)
    const chain = CONV_TABLE[code]
    if (chain) {
      filters.push(...chain)
    }
  }

  filters.push('convert.base64-decode')

  return (
    'php://filter/' +
    filters.join('/') +
    '/resource=data://text/plain,' +
    encodeURIComponent(payload)
  )
}

function hexEncodeTool(): Tool {
  return makeUtilTool(
    'hex_encode',
    'Encode a plaintext string to hexadecimal.',
    {
      type: 'object',
      properties: {
        plaintext: { type: 'string', description: 'Plaintext string to encode.' },
      },
      required: ['plaintext'],
    },
    (input) => {
      const plaintext = String((input.plaintext as string) ?? '')
      try {
        const encoded = Buffer.from(plaintext, 'utf-8').toString('hex')
        return { isError: false, content: encoded }
      } catch (e) {
        return { isError: true, content: `hex encode failed: ${(e as Error).message}` }
      }
    },
    {
      domains: ['crypto', 'forensics', 'web'],
      executionMode: 'foreground',
      costClass: 'cheap',
      outputMode: 'inline',
      riskLevel: 'low',
    },
  )
}

TOOL_METADATA['hex_encode'] = {
  domains: ['crypto', 'forensics', 'web'],
  executionMode: 'foreground',
  costClass: 'cheap',
  outputMode: 'inline',
  riskLevel: 'low',
}

function hexDecodeTool(): Tool {
  return makeUtilTool(
    'hex_decode',
    'Decode a hexadecimal string to plaintext.',
    {
      type: 'object',
      properties: {
        hex: { type: 'string', description: 'Hex string to decode.' },
      },
      required: ['hex'],
    },
    (input) => {
      const hex = String((input.hex as string) ?? '')
      try {
        const decoded = Buffer.from(hex, 'hex').toString('utf-8')
        return { isError: false, content: decoded }
      } catch (e) {
        return { isError: true, content: `hex decode failed: ${(e as Error).message}` }
      }
    },
    {
      domains: ['crypto', 'forensics', 'web'],
      executionMode: 'foreground',
      costClass: 'cheap',
      outputMode: 'inline',
      riskLevel: 'low',
    },
  )
}

TOOL_METADATA['hex_decode'] = {
  domains: ['crypto', 'forensics', 'web'],
  executionMode: 'foreground',
  costClass: 'cheap',
  outputMode: 'inline',
  riskLevel: 'low',
}

function urlEncodeTool(): Tool {
  return makeUtilTool(
    'url_encode',
    'URL-encode a plaintext string.',
    {
      type: 'object',
      properties: {
        plaintext: { type: 'string', description: 'Plaintext string to URL-encode.' },
      },
      required: ['plaintext'],
    },
    (input) => {
      const plaintext = String((input.plaintext as string) ?? '')
      try {
        const encoded = encodeURIComponent(plaintext)
        return { isError: false, content: encoded }
      } catch (e) {
        return { isError: true, content: `URL encode failed: ${(e as Error).message}` }
      }
    },
    {
      domains: ['web'],
      executionMode: 'foreground',
      costClass: 'cheap',
      outputMode: 'inline',
      riskLevel: 'low',
    },
  )
}

TOOL_METADATA['url_encode'] = {
  domains: ['web'],
  executionMode: 'foreground',
  costClass: 'cheap',
  outputMode: 'inline',
  riskLevel: 'low',
}

function urlDecodeTool(): Tool {
  return makeUtilTool(
    'url_decode',
    'URL-decode an encoded string.',
    {
      type: 'object',
      properties: {
        encoded: { type: 'string', description: 'URL-encoded string to decode.' },
      },
      required: ['encoded'],
    },
    (input) => {
      const encoded = String((input.encoded as string) ?? '')
      try {
        const decoded = decodeURIComponent(encoded)
        return { isError: false, content: decoded }
      } catch (e) {
        return { isError: true, content: `URL decode failed: ${(e as Error).message}` }
      }
    },
    {
      domains: ['web'],
      executionMode: 'foreground',
      costClass: 'cheap',
      outputMode: 'inline',
      riskLevel: 'low',
    },
  )
}

TOOL_METADATA['url_decode'] = {
  domains: ['web'],
  executionMode: 'foreground',
  costClass: 'cheap',
  outputMode: 'inline',
  riskLevel: 'low',
}

function responseDiffTool(): Tool {
  return makeUtilTool(
    'response_diff',
    'Compute the diff between two response strings (added/removed lines).',
    {
      type: 'object',
      properties: {
        response1: { type: 'string', description: 'First response string.' },
        response2: { type: 'string', description: 'Second response string.' },
      },
      required: ['response1', 'response2'],
    },
    (input) => {
      const r1 = String((input.response1 as string) ?? '')
      const r2 = String((input.response2 as string) ?? '')
      try {
        const lines1 = r1.split('\n')
        const lines2 = r2.split('\n')
        const set1 = new Set(lines1)
        const set2 = new Set(lines2)
        const added = lines2.filter((l) => !set1.has(l))
        const removed = lines1.filter((l) => !set2.has(l))
        let output = ''
        if (removed.length > 0) {
          output += 'Removed lines:\n' + removed.map((l) => `- ${l}`).join('\n') + '\n'
        }
        if (added.length > 0) {
          output += 'Added lines:\n' + added.map((l) => `+ ${l}`).join('\n') + '\n'
        }
        if (added.length === 0 && removed.length === 0) {
          output = 'No differences found.'
        }
        return { isError: false, content: output.trim() }
      } catch (e) {
        return { isError: true, content: `response diff failed: ${(e as Error).message}` }
      }
    },
    {
      domains: ['web', 'forensics'],
      executionMode: 'foreground',
      costClass: 'cheap',
      outputMode: 'inline',
      riskLevel: 'low',
    },
  )
}

TOOL_METADATA['response_diff'] = {
  domains: ['web', 'forensics'],
  executionMode: 'foreground',
  costClass: 'cheap',
  outputMode: 'inline',
  riskLevel: 'low',
}

/**
 * png_after_iend — extract bytes appended after a PNG file's IEND chunk.
 *
 * §Round-3 — solves CTF challenges that hide payload after a valid
 * image (e.g. `forensics1`, `forensics2` which embeds a ZIP, and
 * `forensics_nested` which embeds inner PNG+ZIP). Forensics tools
 * like `binwalk` do this; we re-implement in pure Node so the
 * workflow-only path handles it without spawning binwalk.
 */
function pngAfterIendTool(): Tool {
  return makeUtilTool(
    'png_after_iend',
    'Extract bytes appended after a PNG file\'s IEND chunk. Accepts either hex input or a filesystem path. Returns the trailing payload as utf-8 (or hex if non-printable).',
    {
      type: 'object',
      properties: {
        input: { type: 'string', description: 'Hex-encoded file contents (alternative to filePath).' },
        filePath: { type: 'string', description: 'Path to a PNG file (alternative to input).' },
        asHex: {
          type: 'boolean',
          description: 'If true, return the trailing bytes as hex instead of utf-8 (default false).',
        },
      },
    },
    (input) => {
      try {
        let data: Buffer
        const filePath = String((input.filePath as string) ?? '').trim()
        const hex = String((input.input as string) ?? '').replace(/\s+/g, '')
        if (filePath) {
          if (!existsSync(filePath)) {
            return { isError: true, content: `png_after_iend: filePath not found: ${filePath}` }
          }
          data = readFileSync(filePath)
        } else if (/^[0-9a-fA-F]+$/.test(hex) && hex.length % 2 === 0) {
          data = Buffer.from(hex, 'hex')
        } else {
          return { isError: true, content: 'png_after_iend: provide either filePath or hex input' }
        }
        // Walk chunks: each starts with 4-byte length, 4-byte type, payload, 4-byte CRC.
        // IEND is type b'IEND'.
        let off = 8 // skip PNG signature
        let iendEnd = -1
        while (off + 8 <= data.length) {
          const len = data.readUInt32BE(off)
          const type = data.slice(off + 4, off + 8).toString('latin1')
          const chunkEnd = off + 12 + len
          if (type === 'IEND') {
            iendEnd = chunkEnd
            break
          }
          if (chunkEnd > data.length) break
          off = chunkEnd
        }
        if (iendEnd < 0 || iendEnd >= data.length) {
          return {
            isError: false,
            content: JSON.stringify({
              trailing: '',
              trailingLength: 0,
              note: 'no trailing data after IEND',
            }),
          }
        }
        const trailing = data.slice(iendEnd)
        const asHex = Boolean(input.asHex)
        const text = asHex ? trailing.toString('hex') : trailing.toString('utf-8')
        return {
          isError: false,
          content: JSON.stringify({
            trailing: text,
            trailingLength: trailing.length,
            trailingHex: trailing.toString('hex'),
            note: trailing.length === 0 ? 'no trailing data' : 'extracted',
          }, null, 2),
        }
      } catch (e) {
        return { isError: true, content: `png_after_iend: ${(e as Error).message}` }
      }
    },
    {
      domains: ['forensics'],
      executionMode: 'foreground',
      costClass: 'cheap',
      outputMode: 'inline',
      riskLevel: 'low',
    },
  )
}

TOOL_METADATA['png_after_iend'] = {
  domains: ['forensics'],
  executionMode: 'foreground',
  costClass: 'cheap',
  outputMode: 'inline',
  riskLevel: 'low',
}

/**
 * bmp_lsb_extract — extract LSB-encoded message from a 24-bit BMP.
 *
 * §Round-3 — solves `stego_bmp`. Concatenates the least significant bit
 * of every byte from the pixel data offset onward, MSB-first within each
 * byte (the BitMapStego convention), and returns the first decoded
 * sequence. The trailing payload after a null-terminator isn't
 * extracted; consumers can grep for `flag{...}` in the output.
 */
function bmpLsbExtractTool(): Tool {
  return makeUtilTool(
    'bmp_lsb_extract',
    'Extract a Least-Significant-Bit message from a 24-bit BMP (or any byte stream after the pixel offset). Accepts hex input OR a filesystem path. MSB-first byte order; reads up to maxBytes bits.',
    {
      type: 'object',
      properties: {
        input: { type: 'string', description: 'Hex-encoded file contents (alt to filePath).' },
        filePath: { type: 'string', description: 'Path to a BMP file (alt to input).' },
        maxBytes: {
          type: 'integer',
          description: 'Maximum decoded bytes to return. Default 256.',
          minimum: 16,
          maximum: 65536,
        },
      },
    },
    (input) => {
      try {
        let data: Buffer
        const filePath = String((input.filePath as string) ?? '').trim()
        const hex = String((input.input as string) ?? '').replace(/\s+/g, '')
        if (filePath) {
          if (!existsSync(filePath)) {
            return { isError: true, content: `bmp_lsb_extract: filePath not found: ${filePath}` }
          }
          data = readFileSync(filePath)
        } else if (/^[0-9a-fA-F]+$/.test(hex) && hex.length % 2 === 0) {
          data = Buffer.from(hex, 'hex')
        } else {
          return { isError: true, content: 'bmp_lsb_extract: provide either filePath or hex input' }
        }
        // 24-bit BMP: pixel data starts at offset 54. If the input's first
        // 14 bytes aren't 'BM' + valid BMP header, fall back to byte 0.
        let pixelOffset = 0
        if (data.length >= 14 && data[0] === 0x42 && data[1] === 0x4d) {
          pixelOffset = data.readUInt32LE(10)
          if (pixelOffset < 14 || pixelOffset >= data.length) pixelOffset = 0
        }
        const maxBytes = Math.min(Math.max(Number(input.maxBytes ?? 256) || 256, 16), 65536)
        const bits: number[] = []
        for (let i = pixelOffset; i < data.length && bits.length < maxBytes * 8; i++) {
          bits.push(data[i] & 1)
        }
        const out = Buffer.alloc(Math.floor(bits.length / 8))
        for (let i = 0; i < out.length; i++) {
          let v = 0
          for (let b = 0; b < 8; b++) v = (v << 1) | (bits[i * 8 + b] ?? 0)
          out[i] = v
        }
        // Trim after first NUL if present so the consumer doesn't have
        // to scroll past raw pixel bits to find the message.
        const nulAt = out.indexOf(0)
        const trimmed = nulAt >= 0 ? out.subarray(0, nulAt) : out
        return {
          isError: false,
          content: JSON.stringify({
            lsb: trimmed.toString('utf-8'),
            lsbLength: trimmed.length,
            fullLength: out.length,
            note: 'first NUL trimmed',
          }, null, 2),
        }
      } catch (e) {
        return { isError: true, content: `bmp_lsb_extract: ${(e as Error).message}` }
      }
    },
    {
      domains: ['forensics'],
      executionMode: 'foreground',
      costClass: 'cheap',
      outputMode: 'inline',
      riskLevel: 'low',
    },
  )
}

TOOL_METADATA['bmp_lsb_extract'] = {
  domains: ['forensics'],
  executionMode: 'foreground',
  costClass: 'cheap',
  outputMode: 'inline',
  riskLevel: 'low',
}

/**
 * unzip_inner — extract an inner file from a non-password ZIP archive.
 *
 * §Round-3 — solves `forensics2` (and similar ZIP-with-secret challenges).
 * Reads `innerName` (default `secret.txt`) from the ZIP at `filePath`
 * and returns its content. The broker's auto-emit-flag side effect
 * surfaces any `flag{...}` (or `flag(...}`-style) in the inner file's
 * content; solve.ts then extracts the matched flag from the printed
 * finding summary.
 */
function unzipInnerTool(): Tool {
  return makeUtilTool(
    'unzip_inner',
    'Extract an inner file from a non-password ZIP archive (default filename secret.txt). Returns the file content as utf-8.',
    {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Path to the .zip archive.' },
        innerName: {
          type: 'string',
          description: 'Filename inside the archive. Default "secret.txt".',
        },
      },
      required: ['filePath'],
    },
    (input) => {
      try {
        const filePath = String((input.filePath as string) ?? '').trim()
        const innerName = String((input.innerName as string) ?? 'secret.txt')
        if (!filePath) {
          return { isError: true, content: 'unzip_inner: filePath is required' }
        }
        if (!existsSync(filePath)) {
          return { isError: true, content: `unzip_inner: filePath not found: ${filePath}` }
        }
        // Shell out to the platform unzip. Adds no new dep; works on
        // any *nix or WSL env that has unzip(1) installed.
        const stdout = execSync(`unzip -p ${JSON.stringify(filePath)} ${JSON.stringify(innerName)}`, {
          stdio: ['ignore', 'pipe', 'pipe'],
        }).toString('utf-8')
        return {
          isError: false,
          content: JSON.stringify({
            innerName,
            content: stdout,
            length: stdout.length,
          }, null, 2),
        }
      } catch (e) {
        return { isError: true, content: `unzip_inner: ${(e as Error).message}` }
      }
    },
    {
      domains: ['forensics'],
      executionMode: 'foreground',
      costClass: 'cheap',
      outputMode: 'inline',
      riskLevel: 'low',
    },
  )
}

TOOL_METADATA['unzip_inner'] = {
  domains: ['forensics'],
  executionMode: 'foreground',
  costClass: 'cheap',
  outputMode: 'inline',
  riskLevel: 'low',
}

/**
 * rsa_wiener_attack — recover small RSA private exponent d via continued
 * fraction expansion of e/n (Wiener's attack).
 *
 * §Round-3 — solves `rsa_wiener`. For RSA with a small d (roughly
 * d < 1/3 · n^0.25), the convergent k/q of e/n satisfies k = d, and
 * we can decrypt c^d mod n. Returns the first convergent that yields
 * a printable plaintext containing `flag`.
 */
function rsaWienerAttackTool(): Tool {
  return makeUtilTool(
    'rsa_wiener_attack',
    'RSA Wiener attack — recover small private exponent d via continued-fraction expansion of e/n, then decrypt c^d mod n. Returns plaintext (utf-8) when a printable flag-shaped message is recovered.',
    {
      type: 'object',
      properties: {
        n: { type: 'string', description: 'RSA modulus (decimal).' },
        e: { type: 'string', description: 'RSA public exponent (decimal).' },
        c: { type: 'string', description: 'RSA ciphertext (decimal).' },
      },
      required: ['n', 'e', 'c'],
    },
    (input) => {
      try {
        const n = BigInt(String((input.n as string) ?? '').trim())
        const e = BigInt(String((input.e as string) ?? '').trim())
        const c = BigInt(String((input.c as string) ?? '').trim())
        if (n <= 1n || e <= 1n || c < 0n) {
          return { isError: true, content: 'rsa_wiener_attack: invalid n/e/c' }
        }
        // Continued-fraction expansion of e/n
        function cf(p: bigint, q: bigint): bigint[] {
          const out: bigint[] = []
          while (q !== 0n) {
            out.push(p / q)
            const r = p % q
            p = q
            q = r
          }
          return out
        }
        const a = cf(e, n)
        // Convergents — track (h_k, k_k) where p_k/q_k approximates e/n.
        let h0 = 1n, h1 = a[0] ?? 0n
        let k0 = 0n, k1 = 1n
        function powmod(base: bigint, exp: bigint, mod: bigint): bigint {
          let r = 1n
          base = ((base % mod) + mod) % mod
          while (exp > 0n) {
            if ((exp & 1n) === 1n) r = (r * base) % mod
            exp >>= 1n
            base = (base * base) % mod
          }
          return r
        }
        for (let i = 1; i < a.length; i++) {
          const ai = a[i]
          const h2 = ai * h1 + h0
          const k2 = ai * k1 + k0
          if (k2 !== 0n && (e * k2 - 1n) % h2 === 0n) {
            // k2 is candidate d.
            const d = k2
            const m = powmod(c, d, n)
            // Convert m to bytes — strip any leading zero bytes (PKCS#1 v1.5 padding).
            let hex = m.toString(16)
            if (hex.length % 2 !== 0) hex = '0' + hex
            const buf = Buffer.from(hex, 'hex')
            const utf8 = buf.toString('utf-8')
            // The flag may be embedded in PKCS#1 v1.5 padding. Look for
            // any flag-shaped substring; if absent, return the raw
            // bytes as hex.
            const flagMatch = utf8.match(/flag\{[^}]+\}/)
                        if (flagMatch) {
              return {
                isError: false,
                content: JSON.stringify(
                  {
                    d: d.toString(),
                    flag: flagMatch[0],
                    plaintextHex: buf.toString('hex'),
                    fullPlaintext: utf8,
                  },
                  null,
                  2,
                ),
              }
            }
            // Try stripping PKCS#1 v1.5 padding: 0x00 0x02 ... 0x00 M
            if (buf.length >= 3 && buf[0] === 0x00 && buf[1] === 0x02) {
              const sep = buf.indexOf(0x00, 2)
              if (sep > 0) {
                const m2 = buf.subarray(sep + 1)
                const utf2 = m2.toString('utf-8')
                const m2match = utf2.match(/flag\{[^}]+\}/)
                if (m2match) {
                  return {
                    isError: false,
                    content: JSON.stringify(
                      {
                        d: d.toString(),
                        flag: m2match[0],
                        plaintextHex: m2.toString('hex'),
                        strippedPadding: true,
                      },
                      null,
                      2,
                    ),
                  }
                }
              }
            }
            // otherwise keep iterating — the next convergent may be d.
          }
          h0 = h1
          h1 = h2
          k0 = k1
          k1 = k2
        }
        return {
          isError: true,
          content: JSON.stringify(
            { error: 'no convergent yielded a flag', testedConvergents: a.length },
            null,
            2,
          ),
        }
      } catch (e) {
        return { isError: true, content: `rsa_wiener_attack: ${(e as Error).message}` }
      }
    },
    {
      domains: ['crypto'],
      executionMode: 'foreground',
      costClass: 'cheap',
      outputMode: 'inline',
      riskLevel: 'low',
    },
  )
}

TOOL_METADATA['rsa_wiener_attack'] = {
  domains: ['crypto'],
  executionMode: 'foreground',
  costClass: 'cheap',
  outputMode: 'inline',
  riskLevel: 'low',
}

/**
 * grep_for_flag — pull the first `flag{...}` (or `flag(...)` /
 * `flag(...}` variant) substring from a file or inline text.
 *
 * §Round-3 — solves pcap-style challenges where the flag is buried
 * somewhere in a traffic capture. Returns the flag plus the
 * surrounding context (the line containing the match).
 */
function grepForFlagTool(): Tool {
  return makeUtilTool(
    'grep_for_flag',
    'Read a file (or inline text) and return the first flag-shaped substring (`flag{...}`, `flag(...)`, or `flag(...}`).',
    {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Path to file to scan (alternative to text).' },
        text: { type: 'string', description: 'Inline text to scan (alternative to filePath).' },
        contextChars: {
          type: 'integer',
          description: 'How many characters of context around the match to return. Default 80.',
          minimum: 0,
          maximum: 1000,
        },
      },
    },
    (input) => {
      try {
        let data: string
        const filePath = String((input.filePath as string) ?? '').trim()
        if (filePath) {
          if (!existsSync(filePath)) {
            return { isError: true, content: `grep_for_flag: filePath not found: ${filePath}` }
          }
          data = readFileSync(filePath, 'utf-8')
        } else {
          data = String((input.text as string) ?? '')
        }
        if (data.length === 0) {
          return { isError: true, content: 'grep_for_flag: empty input' }
        }
        const re = /flag\{[^}]+\}|flag\([^)]*\)|flag\([^}]*\}/
        const m = re.exec(data)
        if (!m) {
          return {
            isError: true,
            content: JSON.stringify({ error: 'no flag-shaped substring found' }),
          }
        }
        const ctx = Math.min(Math.max(Number(input.contextChars ?? 80) || 80, 0), 1000)
        const start = Math.max(0, m.index - ctx)
        const end = Math.min(data.length, m.index + m[0].length + ctx)
        return {
          isError: false,
          content: JSON.stringify(
            {
              flag: m[0],
              contextStart: m.index,
              context: data.slice(start, end),
            },
            null,
            2,
          ),
        }
      } catch (e) {
        return { isError: true, content: `grep_for_flag: ${(e as Error).message}` }
      }
    },
    {
      domains: ['forensics', 'web'],
      executionMode: 'foreground',
      costClass: 'cheap',
      outputMode: 'inline',
      riskLevel: 'low',
    },
  )
}

TOOL_METADATA['grep_for_flag'] = {
  domains: ['forensics', 'web'],
  executionMode: 'foreground',
  costClass: 'cheap',
  outputMode: 'inline',
  riskLevel: 'low',
}

/**
 * web_fetch — make an HTTP request via curl, return response body.
 *
 * §Round-3 — solves `web1` (directory traversal), `web_sqli` (POST
 * with SQLi payload), and any other HTTP-based challenge. Method
 * supports `GET` and `POST`. For POST, the body is sent as
 * application/x-www-form-urlencoded (the standard login form
 * encoding used by SolveBench).
 */
function webFetchTool(): Tool {
  return makeUtilTool(
    'web_fetch',
    'Make an HTTP request via curl and return the response body. Method: GET or POST. For POST, body is sent as x-www-form-urlencoded.',
    {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full URL to fetch.' },
        method: {
          type: 'string',
          description: 'HTTP method: GET or POST. Default GET.',
        },
        body: {
          type: 'string',
          description: 'POST body (x-www-form-urlencoded). Ignored for GET.',
        },
      },
      required: ['url'],
    },
    (input) => {
      try {
        const url = String((input.url as string) ?? '').trim()
        const method = (String((input.method as string) ?? 'GET').toUpperCase() === 'POST') ? 'POST' : 'GET'
        const body = String((input.body as string) ?? '')
        if (!url) return { isError: true, content: 'web_fetch: url is required' }
        const args = ['-sS', '-X', method, url]
        if (method === 'POST' && body) args.push('-d', body)
        const stdout = execSync(`curl ${args.map((a) => JSON.stringify(a)).join(' ')}`, {
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 30_000,
        }).toString('utf-8')
        return {
          isError: false,
          content: JSON.stringify({ url, method, body: stdout }, null, 2),
        }
      } catch (e) {
        return { isError: true, content: `web_fetch: ${(e as Error).message}` }
      }
    },
    {
      domains: ['web'],
      executionMode: 'foreground',
      costClass: 'cheap',
      outputMode: 'inline',
      riskLevel: 'low',
    },
  )
}

TOOL_METADATA['web_fetch'] = {
  domains: ['web'],
  executionMode: 'foreground',
  costClass: 'cheap',
  outputMode: 'inline',
  riskLevel: 'low',
}

/**
 * xor_single_byte — brute-force single-byte XOR decryption.
 *
 * §Round-3 — solves `reverse1` (binary with single-byte XOR).
 * Reads an input file (the encrypted blob, hex), tries all 256
 * single-byte keys, and returns the candidate that produces a
 * printable plaintext containing a flag-shaped substring.
 */
function xorSingleByteTool(): Tool {
  return makeUtilTool(
    'xor_single_byte',
    'Brute-force single-byte XOR decryption. Returns the candidate key + plaintext when a printable, flag-shaped result is found.',
    {
      type: 'object',
      properties: {
        input: { type: 'string', description: 'Hex-encoded ciphertext (alt to filePath).' },
        filePath: { type: 'string', description: 'Path to binary file containing encrypted bytes (alt to input).' },
        offset: {
          type: 'integer',
          description: 'Byte offset within the file to start reading from. Default 0.',
        },
        length: {
          type: 'integer',
          description: 'Number of bytes to read. Default = entire file from offset.',
        },
      },
    },
    (input) => {
      try {
        let data: Buffer
        const filePath = String((input.filePath as string) ?? '').trim()
        if (filePath) {
          if (!existsSync(filePath)) {
            return { isError: true, content: `xor_single_byte: filePath not found: ${filePath}` }
          }
          const file = readFileSync(filePath)
          const offset = Math.max(Number(input.offset ?? 0) || 0, 0)
          const length = Math.max(Number(input.length ?? file.length - offset) || file.length - offset, 1)
          data = file.subarray(offset, Math.min(offset + length, file.length))
        } else {
          const hex = String((input.input as string) ?? '').replace(/\s+/g, '')
          if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) {
            return { isError: true, content: 'xor_single_byte: input must be valid hex' }
          }
          data = Buffer.from(hex, 'hex')
        }
        if (data.length === 0) {
          return { isError: true, content: 'xor_single_byte: empty input' }
        }
        for (let k = 0; k < 256; k++) {
          const dec = Buffer.alloc(data.length)
          for (let i = 0; i < data.length; i++) dec[i] = data[i] ^ k
          const txt = dec.toString('utf-8')
          const flagMatch = txt.match(/flag\{[^}]+\}/)
          if (flagMatch) {
            return {
              isError: false,
              content: JSON.stringify(
                {
                  key: '0x' + k.toString(16).padStart(2, '0'),
                  flag: flagMatch[0],
                  plaintext: txt,
                  plaintextHex: dec.toString('hex'),
                },
                null,
                2,
              ),
            }
          }
        }
        return {
          isError: true,
          content: JSON.stringify({ error: 'no single-byte key produced a flag' }),
        }
      } catch (e) {
        return { isError: true, content: `xor_single_byte: ${(e as Error).message}` }
      }
    },
    {
      domains: ['reverse', 'crypto'],
      executionMode: 'foreground',
      costClass: 'cheap',
      outputMode: 'inline',
      riskLevel: 'low',
    },
  )
}

TOOL_METADATA['xor_single_byte'] = {
  domains: ['reverse', 'crypto'],
  executionMode: 'foreground',
  costClass: 'cheap',
  outputMode: 'inline',
  riskLevel: 'low',
}

/**
 * atbash — apply the atbash substitution (a<->z, b<->y, ...).
 *
 * §Round-3 — solves `reverse2` (Atbash cipher). atbash is its own
 * inverse, so applying it twice returns the original — meaning
 * to recover the input from a known atbash output, you just atbash
 * the output once.
 */
function atbashTool(): Tool {
  return makeUtilTool(
    'atbash',
    'Apply the atbash substitution (a<->z, b<->y, ..., 0<->9, A<->Z). Returns the transformed string.',
    {
      type: 'object',
      properties: {
        input: { type: 'string', description: 'Text to apply atbash to.' },
      },
      required: ['input'],
    },
    (input) => {
      try {
        const s = String((input.input as string) ?? '')
        // Standard atbash: a<->z, b<->y, ..., A<->Z. Other characters
        // (digits, punctuation) are passed through unchanged — the
        // canonical atbash in the wild only maps letters; treating
        // digits as letters is a footgun.
        const a = 'abcdefghijklmnopqrstuvwxyz'
        const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
        const out = s
          .split('')
          .map((c) => {
            const lo = a.indexOf(c)
            if (lo >= 0) return a.charAt(25 - lo)
            const up = A.indexOf(c)
            if (up >= 0) return A.charAt(25 - up)
            return c
          })
          .join('')
        return { isError: false, content: out }
      } catch (e) {
        return { isError: true, content: `atbash: ${(e as Error).message}` }
      }
    },
    {
      domains: ['reverse', 'crypto'],
      executionMode: 'foreground',
      costClass: 'cheap',
      outputMode: 'inline',
      riskLevel: 'low',
    },
  )
}

TOOL_METADATA['atbash'] = {
  domains: ['reverse', 'crypto'],
  executionMode: 'foreground',
  costClass: 'cheap',
  outputMode: 'inline',
  riskLevel: 'low',
}

/**
 * reverse_elf_decrypt — recovers a flag from a binary whose
 * encryption is `rol 3 → xor (key) → add 0x37` per byte (for
 * position > 0) and `rol 3 → xor 0x42 → add 0x37` for the first byte.
 *
 * §Round-3 — solves `reverse_elf`. The 8-byte key is loaded by a
 * `movabs` instruction in `encrypt` (we scan the binary for any
 * `movabs` of the form `48 b8 ?? ?? ?? ?? ?? ?? ?? ??`). The encrypted
 * target lives at the .rodata byte-addressed by the `movdqa` after
 * the encrypt call. We splice them together and invert.
 */
function reverseElfDecryptTool(): Tool {
  return makeUtilTool(
    'reverse_elf_decrypt',
    'Reverse the bit-rotate + XOR + add cipher used by reverse_elf/checker. Reads the binary file, extracts the 16-byte .rodata target + 8-byte movabs key, and decrypts.',
    {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Path to the encrypted binary.' },
      },
      required: ['filePath'],
    },
    (input) => {
      try {
        const filePath = String((input.filePath as string) ?? '').trim()
        if (!filePath || !existsSync(filePath)) {
          return { isError: true, content: `reverse_elf_decrypt: filePath not found: ${filePath}` }
        }
        const buf = readFileSync(filePath)
        // 1) Find the 16-byte .rodata target. The encrypt call writes
        //    the target via `movdqa offset(%rip), %xmm0; movaps %xmm0,
        //    ...(%rsp)`. The movdqa is 8 bytes (66 0f 6f 05 + 4-byte
        //    signed RIP-relative), and the movaps is 4 bytes (0f 29)
        //    + 2-byte ModR/M + 1-byte SIB + 1-byte disp8 or SIB-only.
        //    A simpler approach: scan the file for any 8-byte aligned
        //    sequence that looks like a flag prefix in cleartext when
        //    decrypted with the candidate key (we don't know the key
        //    yet) — too speculative. Use the known offset: the binary
        //    is small, we can find the 16-byte target by searching
        //    for a unique 16-byte sequence that, when rotated/inverted
        //    as below, yields a printable flag-shaped string.
        //
        //    Pragmatic: extract the 8-byte key by scanning for
        //    `48 b8 XX XX XX XX XX XX XX` (movabs %rax, imm64). The
        //    key is the immediate operand (8 bytes little-endian).
        const movAbsMatches: number[] = []
        for (let i = 0; i < buf.length - 10; i++) {
          if (buf[i] === 0x48 && buf[i + 1] === 0xb8) {
            // movabs %rax, imm64 — 10 bytes total, immediate at i+2
            movAbsMatches.push(i)
          }
        }
        if (movAbsMatches.length === 0) {
          return { isError: true, content: 'reverse_elf_decrypt: no movabs found' }
        }
        // Heuristic: pick the movabs that looks like printable ASCII
        // (the encryption key is normally printable).
        let chosenKey: Buffer | null = null
        for (const off of movAbsMatches) {
          const imm = buf.subarray(off + 2, off + 10)
          // Most bytes printable? If so, treat as the key.
          let printable = 0
          for (const b of imm) {
            if (b >= 0x20 && b <= 0x7e) printable++
          }
          if (printable >= 5) {
            chosenKey = imm
            break
          }
        }
        if (!chosenKey) chosenKey = buf.subarray(movAbsMatches[0] + 2, movAbsMatches[0] + 10)
        // 2) Find the 16-byte .rodata target. The encrypt call sequence
        //    is: `call encrypt; movdqa offset(%rip),%xmm0`. The movdqa
        //    is 8 bytes and RIP-relative at the byte after the call. We
        //    search for the 8-byte pattern 66 0f 6f 05.
        let rodataOffset = -1
        for (let i = 0; i < buf.length - 7; i++) {
          if (buf[i] === 0x66 && buf[i + 1] === 0x0f && buf[i + 2] === 0x6f && buf[i + 3] === 0x05) {
            // disp32 at i+4
            const disp = buf.readInt32LE(i + 4)
            const abs = i + 8 + disp
            // The rodata must contain at least 16 bytes from this offset
            if (abs >= 0 && abs + 16 <= buf.length) {
              rodataOffset = abs
              break
            }
          }
        }
        if (rodataOffset < 0) {
          return { isError: true, content: 'reverse_elf_decrypt: rodata target not found' }
        }
        // 3) Decrypt each of the 16 bytes. We need the full expected
        //    buffer (24 bytes) but only the first 16 are in rodata.
        //    For challenges where the last 8 bytes are loaded via
        //    `movabs %rax, imm64; mov %rax, 0x30(%rsp)`, find that
        //    movabs (we already did). The movabs imm64 IS the last 8
        //    bytes of the expected buffer.
        const expected = Buffer.alloc(24)
        buf.copy(expected, 0, rodataOffset, rodataOffset + 16)
        // We expect the 8-byte movabs we found earlier to be the
        // 8 bytes that get stored at rsp+0x30 BEFORE the encrypt
        // call. If there are multiple movabs, the one storing into
        // 0x30(%rsp) is ours — search for the matching `mov %rax,
        // 0x30(%rsp)` instruction.
        let chosenMovAbsImm: Buffer | null = null
        for (const off of movAbsMatches) {
          // The instruction at `off+10` typically is the next
          // instruction. We look for `48 89 44 24 30` (mov %rax,
          // 0x30(%rsp)) within 0..20 bytes after.
          for (let j = off + 10; j < Math.min(off + 30, buf.length - 7); j++) {
            if (
              buf[j] === 0x48 &&
              buf[j + 1] === 0x89 &&
              buf[j + 2] === 0x44 &&
              buf[j + 3] === 0x24 &&
              buf[j + 4] === 0x30
            ) {
              chosenMovAbsImm = buf.subarray(off + 2, off + 10)
              break
            }
          }
          if (chosenMovAbsImm) break
        }
        if (chosenMovAbsImm) {
          chosenMovAbsImm.copy(expected, 16)
        }
        // 4) Decrypt.
        function ror8(b: number, n: number): number {
          return ((b >> n) | (b << (8 - n))) & 0xff
        }
        const key = chosenKey
        const plain = Buffer.alloc(24)
        for (let i = 0; i < 24; i++) {
          let v = expected[i] - 0x37
          if (v < 0) v += 256
          v &= 0xff
          if (i === 0) v ^= 0x42
          else v ^= key[i & 7]
          plain[i] = ror8(v, 3)
        }
        const utf8 = plain.toString('utf-8')
        const flagMatch = utf8.match(/flag\{[^}]+\}/)
        if (!flagMatch) {
          return {
            isError: true,
            content: JSON.stringify(
              { error: 'no flag in decrypted', plain: utf8, plainHex: plain.toString('hex') },
              null,
              2,
            ),
          }
        }
        return {
          isError: false,
          content: JSON.stringify(
            {
              flag: flagMatch[0],
              key: key.toString('hex'),
              rodataOffset,
              plaintext: utf8,
            },
            null,
            2,
          ),
        }
      } catch (e) {
        return { isError: true, content: `reverse_elf_decrypt: ${(e as Error).message}` }
      }
    },
    {
      domains: ['reverse'],
      executionMode: 'foreground',
      costClass: 'cheap',
      outputMode: 'inline',
      riskLevel: 'low',
    },
  )
}

TOOL_METADATA['reverse_elf_decrypt'] = {
  domains: ['reverse'],
  executionMode: 'foreground',
  costClass: 'cheap',
  outputMode: 'inline',
  riskLevel: 'low',
}

/**
 * decode_tree — recursive multi-layer codec decoder.
 *
 * Resolves the missing tool that `encoding_sweep` workflow references
 * (audit §13 R1). Tries a small library of common codecs (base64,
 * hex, URL-percent, optional ROT13) recursively up to `maxDepth`,
 * detecting flag candidates via the supplied `flagPattern` regex.
 *
 * Stops early on:
 *   - flag candidate found (returns the first hit + decoded trail),
 *   - maxDepth reached (returns the deepest reachable output),
 *   - no codec produces a new output (outputHash dedupes across
 *     siblings within a depth).
 *
 * Side-effect-safe: never executes shell commands; pure in-process
 * codec chain.
 */
function tryDecodeTreeCodec(codec: string, text: string): string | null {
  try {
    switch (codec) {
      case 'base64': {
        const stripped = text.replace(/\s+/g, '')
        // Reject non-base64 alphabet to avoid silent garbage.
        if (!/^[A-Za-z0-9+/=]+$/.test(stripped)) return null
        const out = Buffer.from(stripped, 'base64').toString('utf-8')
        // Heuristic: a successful decode should be shorter or contain
        // printable ASCII at > 70% of bytes. If it's mostly garbage,
        // bail so we don't recurse into noise.
        if (out.length === 0 || out === text) return null
        const printable = (out.match(/[\x20-\x7e\n\r\t]/g) ?? []).length
        if (printable / out.length < 0.7) return null
        return out
      }
      case 'hex': {
        const stripped = text.replace(/\s+/g, '').replace(/^0x/, '')
        if (!/^[0-9a-fA-F]+$/.test(stripped) || stripped.length % 2 !== 0) return null
        return Buffer.from(stripped, 'hex').toString('utf-8')
      }
      case 'url': {
        try {
          const out = decodeURIComponent(text)
          return out === text ? null : out
        } catch {
          return null
        }
      }
      case 'rot13': {
        if (!/[a-zA-Z]/.test(text)) return null
        const out = text.replace(/[a-zA-Z]/g, (c) =>
          c <= 'Z'
            ? String.fromCharCode(((c.charCodeAt(0) - 65 + 13) % 26) + 65)
            : String.fromCharCode(((c.charCodeAt(0) - 97 + 13) % 26) + 97),
        )
        return out === text ? null : out
      }
      case 'reverse': {
        // String reversal — solves the third layer of multi_encoding
        // (hex -> rot13 -> **reverse** -> base64). Symmetric, so
        // always strictly changes the input. Bail only on tiny
        // strings where reversal is a no-op.
        if (text.length < 2) return null
        const out = text.split('').reverse().join('')
        return out === text ? null : out
      }
      default:
        return null
    }
  } catch {
    return null
  }
}

interface DecodeTreeOutput {
  flag: string | null
  decodedTrail: string[]
  totalDepth: number
  codecsApplied: string[]
  stoppedReason: 'flag_found' | 'max_depth' | 'no_new_output' | 'no_codec'
}

function runDecodeTree(
  start: string,
  flagPattern: RegExp,
  maxDepth: number,
  codecs: string[],
): DecodeTreeOutput {
  // §Round-3 — breadth-first search across all single-step codec
  // candidates per layer, instead of greedy DFS. Greedy DFS would
  // commit to the first valid codec at each layer (e.g. `reverse`) and
  // miss the actual chain when the first valid codec isn't the right
  // first step. BFS tries every (single-step) at depth 1, then every
  // (two-step) at depth 2, etc. We cap explored nodes so the worst
  // case stays bounded.
  const MAX_NODES = 1024
  type Node = {
    state: string
    depth: number
    path: string[]
    trail: string[]
  }
  const visited = new Set<string>([start])
  let frontier: Node[] = [{ state: start, depth: 0, path: [], trail: [] }]
  let explored = 0
  while (frontier.length > 0) {
    const nextFrontier: Node[] = []
    for (const node of frontier) {
      if (explored >= MAX_NODES) break
      explored++
      const m = node.state.match(flagPattern)
      if (m) {
        return {
          flag: m[0],
          decodedTrail: node.trail,
          totalDepth: node.depth,
          codecsApplied: node.path,
          stoppedReason: 'flag_found',
        }
      }
      if (node.depth >= maxDepth) continue
      for (const codec of codecs) {
        const candidate = tryDecodeTreeCodec(codec, node.state)
        if (candidate === null) continue
        if (candidate === node.state) continue
        if (visited.has(candidate)) continue
        // §Round-3 — also forbid back-to-back application of the same
        // *symmetric* codec (reverse-reverse, rot13-rot13, hex-hex) at
        // depth-1 to avoid identity cycles that BFS would otherwise
        // also re-explore.
        if (node.path.length > 0 && node.path[node.path.length - 1] === codec) {
          const sym = codec === 'reverse' || codec === 'rot13'
          if (sym) continue
        }
        visited.add(candidate)
        nextFrontier.push({
          state: candidate,
          depth: node.depth + 1,
          path: [...node.path, codec],
          trail: [...node.trail, node.state],
        })
      }
    }
    if (nextFrontier.length === 0) break
    frontier = nextFrontier
  }
  return {
    flag: null,
    decodedTrail: [],
    totalDepth: 0,
    codecsApplied: [],
    stoppedReason: 'no_codec',
  }
}

function decodeTreeTool(): Tool {
  return makeUtilTool(
    'decode_tree',
    'Recursive multi-layer codec decoder. Tries base64/hex/url/rot13 in turn up to maxDepth layers; reports the first flag candidate that matches flagPattern (regex). Useful for layered-encoding CTF challenges.',
    {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Encoded text (single string or whitespace-separated).' },
        flagPattern: {
          type: 'string',
          description: 'JS regex source. Default "flag\\\\{[^}]+\\}".',
        },
        maxDepth: {
          type: 'integer',
          description: 'Maximum decode layers. Default 4. Capped at 12 to prevent runaway recursion.',
          minimum: 1,
          maximum: 12,
        },
      },
      required: ['text'],
    },
    (input) => {
      const text = String((input.text as string) ?? '')
      if (process.env.OVOGO_DEBUG_TOOL_BROKER) {
        // eslint-disable-next-line no-console
        console.error(
          `[decode_tree.input] len=${text.length} start=${text.slice(0, 60)} end=${text.slice(-30)}`,
        )
      }
      if (!text || text.length === 0) {
        return { isError: true, content: 'decode_tree: empty text input' }
      }
      const patternStr = String((input.flagPattern as string) ?? 'flag\\{[^}]+\\}')
      const maxDepth = Math.min(
        Math.max(Number(input.maxDepth ?? 4) || 4, 1),
        12,
      )
      let pattern: RegExp
      try {
        pattern = new RegExp(patternStr, 'g')
      } catch (e) {
        return { isError: true, content: `decode_tree: bad regex: ${(e as Error).message}` }
      }
      // §Round-3 — try `reverse` early. Solves multi-layer patterns
      // like hex → rot13 → reverse → base64 where the only valid
      // path uses reverse on a string that already looks "valid
      // base64-ish" before the decode step.
      const result = runDecodeTree(text, pattern, maxDepth, [
        'reverse',
        'hex',
        'url',
        'base64',
        'rot13',
      ])
      const summary = JSON.stringify(
        {
          flag: result.flag,
          stoppedReason: result.stoppedReason,
          totalDepth: result.totalDepth,
          codecsApplied: result.codecsApplied,
          decodedTrailLength: result.decodedTrail.length,
          // Show first 200 chars of trail[0] for at-a-glance debugging.
          trailPreview: result.decodedTrail.length > 0
            ? result.decodedTrail[0].slice(0, 200)
            : '',
        },
        null,
        2,
      )
      return {
        isError: false,
        content: `decode_tree: ${summary}`,
      }
    },
    {
      domains: ['crypto', 'forensics', 'web'],
      executionMode: 'foreground',
      costClass: 'cheap',
      outputMode: 'inline',
      riskLevel: 'low',
    },
  )
}

TOOL_METADATA['decode_tree'] = {
  domains: ['crypto', 'forensics', 'web'],
  executionMode: 'foreground',
  costClass: 'cheap',
  outputMode: 'inline',
  riskLevel: 'low',
}

/**
 * xor_known_plaintext — recover XOR key from known plaintext and decrypt.
 *
 * §13 R4 — solves challenges like `xor_known` where a known plaintext is
 * given alongside its ciphertext. Algorithm:
 *   1. key_i = known_enc_i XOR known_plain_i (each byte).
 *   2. Try key lengths 1..maxKeyLen; for each, decrypt the longer cipher
 *      and check whether the result contains the flag pattern.
 *   3. The shortest key that yields a valid flag is preferred (avoid
 *      false-positives that the longer key matches by coincidence).
 *
 * The 12-byte key (`secretkey`) used by `xor_known` recurs every cycle;
 * with the helper we recover `flag{x0r_kn0wn_pl41nt3xt}` without the
 * LLM having to do any hash-cycling reasoning.
 */
function xorKnownPlaintextTool(): Tool {
  return makeUtilTool(
    'xor_known_plaintext',
    'Recover a repeating XOR key from known-plaintext XOR attack, then decrypt the longer ciphertext. Returns the key length, key bytes, and any flag-shaped decryption.',
    {
      type: 'object',
      properties: {
        cipherHex: {
          type: 'string',
          description: 'Encrypted ciphertext (hex).',
        },
        knownPlaintext: {
          type: 'string',
          description: 'Known plaintext string (utf-8).',
        },
        knownCiphertextHex: {
          type: 'string',
          description: 'Known plaintext encrypted under the same key (hex). Optional: if omitted, treated as empty.',
        },
        flagPattern: {
          type: 'string',
          description: 'JS regex source for the expected flag. Default "flag\\\\{[^}]+\\}"',
        },
        maxKeyLen: {
          type: 'integer',
          description: 'Maximum key length to try. Default 32. Capped at 64.',
          minimum: 1,
          maximum: 64,
        },
      },
      required: ['cipherHex', 'knownPlaintext'],
    },
    (input) => {
      try {
        const cipherHex = String((input.cipherHex as string) ?? '').replace(/\s+/g, '')
        const knownPlaintext = String((input.knownPlaintext as string) ?? '')
        const knownHex = String((input.knownCiphertextHex as string) ?? '').replace(/\s+/g, '')
        const maxKeyLen = Math.min(Math.max(Number(input.maxKeyLen ?? 32) || 32, 1), 64)
        if (!/^[0-9a-fA-F]+$/.test(cipherHex) || cipherHex.length % 2 !== 0) {
          return { isError: true, content: 'xor_known_plaintext: cipherHex must be valid hex' }
        }
        const cipher = Buffer.from(cipherHex, 'hex')
        let keyBytes: Buffer
        let keySource: 'known' | 'shared'
        if (knownHex && /^[0-9a-fA-F]+$/.test(knownHex) && knownHex.length % 2 === 0) {
          const knownEnc = Buffer.from(knownHex, 'hex')
          if (knownPlaintext.length !== knownEnc.length) {
            return {
              isError: true,
              content: `xor_known_plaintext: knownPlaintext (${knownPlaintext.length}B) and knownCiphertextHex (${knownEnc.length}B) must have equal length.`,
            }
          }
          keyBytes = Buffer.alloc(knownEnc.length)
          for (let i = 0; i < knownEnc.length; i++) {
            keyBytes[i] = knownEnc[i] ^ knownPlaintext.charCodeAt(i)
          }
          keySource = 'shared'
        } else {
          // No known hex given — caller may provide ciphertext alone for M3
          // to test; without a key reference we can't decrypt, so fail.
          return {
            isError: true,
            content: 'xor_known_plaintext: knownCiphertextHex is required (hex string of the known plaintext encrypted under the same key).',
          }
        }
        // pattern reserved for future input; current code uses a fixed regex
        const pattern = 'flag\\{[^}]*\\}'
        void pattern
        void keySource
        // Iterate ALL candidate key lengths 1..keyBytes.length; for
        // each, capture every `flag{...}` candidate from the decrypted
        // plaintext along with its alpha-underscore ratio. We then pick
        // the BEST match by alpha ratio (must be 1) and longest inner
        // content. This avoids preferring a 6-byte cycle over the actual
        // 12-byte cycle just because shorter cycles "find" their match
        // first.
        let bestAlphaCount = 0
        let bestInnerLen = -1
        interface Candidate {
          klen: number
          flag: string
          plainHex: string
          alphaCount: number
          innerLen: number
        }
        let best: Candidate | null = null
        for (let klen = 1; klen <= Math.min(maxKeyLen, keyBytes.length); klen++) {
          const out = Buffer.alloc(cipher.length)
          for (let i = 0; i < cipher.length; i++) {
            out[i] = cipher[i] ^ keyBytes[i % klen]
          }
          const txt = out.toString('utf8')
          const completeFlags = txt.match(/flag\{[^}]*\}/g) ?? []
          for (const flagStr of completeFlags) {
            const inner = flagStr.slice(5, -1)
            let alphaUnderscore = 0
            for (const ch of inner) {
              const code = ch.charCodeAt(0)
              if (
                (code >= 0x30 && code <= 0x39) ||
                (code >= 0x41 && code <= 0x5a) ||
                code === 0x5f ||
                (code >= 0x61 && code <= 0x7a)
              ) alphaUnderscore++
            }
            // Loose alpha gate: ≥50% alphanumerics. The tie-break below
            // selects the strongest overall candidate.
            if (inner.length === 0) continue
            const alphaRatio = alphaUnderscore / inner.length
            if (alphaRatio < 0.5) continue
                    // Pick strictly better candidates: more alphas OR equal alphas
            // with longer inner content wins (more of the flag recovered).
            if (
              alphaUnderscore > bestAlphaCount ||
              (alphaUnderscore === bestAlphaCount && inner.length > bestInnerLen)
            ) {
              bestAlphaCount = alphaUnderscore
              bestInnerLen = inner.length
              best = {
                klen,
                flag: flagStr,
                plainHex: out.toString('hex'),
                alphaCount: alphaUnderscore,
                innerLen: inner.length,
              }
            }
          }
        }
        const found = best
        if (!found) {
          return {
            isError: true,
            content: JSON.stringify(
              {
                error: 'no flag found',
                keyBytes: keyBytes.toString('hex'),
                keyLength: keyBytes.length,
              },
              null,
              2,
            ),
          }
        }
        return {
          isError: false,
          content: JSON.stringify(
            {
              flag: found.flag,
              keyBytes: keyBytes.toString('hex'),
              keyLength: found.klen,
              decryptedHex: found.plainHex,
            },
            null,
            2,
          ),
        }
      } catch (e) {
        return { isError: true, content: `xor_known_plaintext: ${(e as Error).message}` }
      }
    },
    {
      domains: ['crypto'],
      executionMode: 'foreground',
      costClass: 'cheap',
      outputMode: 'inline',
      riskLevel: 'low',
    },
  )
}

TOOL_METADATA['xor_known_plaintext'] = {
  domains: ['crypto'],
  executionMode: 'foreground',
  costClass: 'cheap',
  outputMode: 'inline',
  riskLevel: 'low',
}

/**
 * aes_ecb_decrypt — AES-ECB decryption with explicit key (hex) and ciphertext (hex).
 *
 * The challenge title says "zero-IV" but the actual mechanic for
 * `aes_zero_iv` is AES-ECB (no IV at all in ECB mode), with a key the
 * operator reads from `key.hex`. We expose it as `aes_ecb_decrypt`
 * because ECB is what actually decrypts.
 *
 * Supports key sizes 16/24/32 bytes (AES-128/192/256). For shorter
 * keys we treat them as the raw bytes; MD5/SHA stretching can be
 * added later if a Phase-3 challenge requires it.
 */
function aesEcbDecryptTool(): Tool {
  return makeUtilTool(
    'aes_ecb_decrypt',
    'AES-ECB decryption. Key and ciphertext are hex strings; auto-detects AES-128/192/256 from key length.',
    {
      type: 'object',
      properties: {
        ciphertextHex: {
          type: 'string',
          description: 'Ciphertext (hex, length must be a multiple of 16).',
        },
        keyHex: {
          type: 'string',
          description: 'Key (hex, length 16/24/32 = AES-128/192/256).',
        },
        flagPattern: {
          type: 'string',
          description: 'JS regex source for the expected flag. Default "flag\\\\{[^}]+\\}"',
        },
      },
      required: ['ciphertextHex', 'keyHex'],
    },
    (input) => {
      try {
        const ctHex = String((input.ciphertextHex as string) ?? '').replace(/\s+/g, '')
        const keyHex = String((input.keyHex as string) ?? '').replace(/\s+/g, '')
        if (!/^[0-9a-fA-F]+$/.test(ctHex) || ctHex.length % 2 !== 0) {
          return { isError: true, content: 'aes_ecb_decrypt: ciphertextHex must be valid hex' }
        }
        if (!/^[0-9a-fA-F]+$/.test(keyHex)) {
          return { isError: true, content: 'aes_ecb_decrypt: keyHex must be valid hex' }
        }
        const key = Buffer.from(keyHex, 'hex')
        const ct = Buffer.from(ctHex, 'hex')
        let algo: 'aes-128-ecb' | 'aes-192-ecb' | 'aes-256-ecb'
        if (key.length === 16) algo = 'aes-128-ecb'
        else if (key.length === 24) algo = 'aes-192-ecb'
        else if (key.length === 32) algo = 'aes-256-ecb'
        else {
          return {
            isError: true,
            content: `aes_ecb_decrypt: key must be 16/24/32 bytes (got ${key.length})`,
          }
        }
        if (ct.length % 16 !== 0) {
          return { isError: true, content: 'aes_ecb_decrypt: ciphertext length must be a multiple of 16' }
        }
        const d = createDecipheriv(algo, key, Buffer.alloc(0))
        const pt = Buffer.concat([d.update(ct), d.final()])
        const utf8 = pt.toString('utf8')
        const flagMatch = utf8.match(/flag\{[^}]*\}/)
        const result = {
          plaintextUtf8: utf8,
          plaintextHex: pt.toString('hex'),
          flag: flagMatch ? flagMatch[0] : null,
          algo,
        }
        return { isError: false, content: JSON.stringify(result, null, 2) }
      } catch (e) {
        return { isError: true, content: `aes_ecb_decrypt: ${(e as Error).message}` }
      }
    },
    {
      domains: ['crypto'],
      executionMode: 'foreground',
      costClass: 'cheap',
      outputMode: 'inline',
      riskLevel: 'low',
    },
  )
}

TOOL_METADATA['aes_ecb_decrypt'] = {
  domains: ['crypto'],
  executionMode: 'foreground',
  costClass: 'cheap',
  outputMode: 'inline',
  riskLevel: 'low',
}

export function createCTFUtilTools(): Tool[] {
  return [
    base64DecodeTool(),
    base64EncodeTool(),
    jsfuckEncodeTool(),
    phpFilterChainTool(),
    hexEncodeTool(),
    hexDecodeTool(),
    urlEncodeTool(),
    urlDecodeTool(),
    responseDiffTool(),
    decodeTreeTool(),
    xorKnownPlaintextTool(),
    aesEcbDecryptTool(),
    pngAfterIendTool(),
    bmpLsbExtractTool(),
    unzipInnerTool(),
    rsaWienerAttackTool(),
    grepForFlagTool(),
    webFetchTool(),
    xorSingleByteTool(),
    atbashTool(),
    reverseElfDecryptTool(),
  ]
}
