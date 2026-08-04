import type { Tool, ToolDefinition, ToolResult } from '../core/types.js'
import { TOOL_METADATA } from '../core/toolMetadata.js'
import type { CTFToolMetadata } from '../core/toolDefinition.js'

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
  const trail: string[] = []
  const appliedCodecs: string[] = []
  let current = start
  for (let depth = 0; depth < maxDepth; depth++) {
    const flagMatch = current.match(flagPattern)
    if (flagMatch) {
      return {
        flag: flagMatch[0],
        decodedTrail: trail,
        totalDepth: depth,
        codecsApplied: appliedCodecs,
        stoppedReason: 'flag_found',
      }
    }
    let nextProduced = false
    let next: string | null = null
    let appliedCodec: string | null = null
    for (const codec of codecs) {
      const candidate = tryDecodeTreeCodec(codec, current)
      if (candidate === null) continue
      if (candidate === current) continue
      next = candidate
      appliedCodec = codec
      nextProduced = true
      break
    }
    if (!nextProduced || next === null) {
      return {
        flag: null,
        decodedTrail: trail,
        totalDepth: depth,
        codecsApplied: appliedCodecs,
        stoppedReason: 'no_codec',
      }
    }
    trail.push(current)
    if (appliedCodec !== null) appliedCodecs.push(appliedCodec)
    if (next !== null) current = next
  }
  // Loop exhausted without flag — check current one final time
  const finalMatch = current.match(flagPattern)
  if (finalMatch) {
    return {
      flag: finalMatch[0],
      decodedTrail: trail,
      totalDepth: maxDepth,
      codecsApplied: appliedCodecs,
      stoppedReason: 'flag_found',
    }
  }
  return {
    flag: null,
    decodedTrail: trail,
    totalDepth: maxDepth,
    codecsApplied: appliedCodecs,
    stoppedReason: 'no_new_output',
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
      const result = runDecodeTree(text, pattern, maxDepth, [
        'base64',
        'hex',
        'url',
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
  ]
}
