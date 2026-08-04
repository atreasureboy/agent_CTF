/**
 * decode_tree tool — direct end-to-end test.
 *
 * audit §13 R1: this tool was added to `src/tools/ctfUtils.ts` and
 * registered in TOOL_METADATA to make `encoding_sweep` workflow actually
 * decode multi-layer CTF challenges. Verifies the recursive decoder
 * itself, independent of the workflow runner's inter-step plumbing,
 * by calling the tool's `execute(input)` directly.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { createCTFUtilTools } from '../src/tools/ctfUtils.js'

const TOOL_CTX = {
  cwd: process.cwd(),
  signal: new AbortController().signal,
  permissionMode: 'auto' as const,
  apiConfig: { apiKey: 'noop', baseURL: 'noop', model: 'noop' },
}

describe('decode_tree (audit §13 R1)', () => {
  it('decodes 3× base64 → flag{...} for encoding1 challenge', async () => {
    const encoded = readFileSync(
      'bench/solvebench/challenges/encoding1/encoded.txt',
      'utf-8',
    )
    const tool = createCTFUtilTools().find((t) => t.name === 'decode_tree')
    expect(tool, 'decode_tree tool must be registered in createCTFUtilTools()').toBeDefined()
    const result = await tool!.execute(
      {
        text: encoded,
        flagPattern: 'flag\\{[^}]+\\}',
        maxDepth: 4,
      },
      TOOL_CTX,
    )
    expect(result.isError).toBe(false)
    // The tool returns JSON; the flag must surface in the JSON body.
    const body = result.content
    expect(body).toContain('flag{b4s3_64_1s_n0t_3ncrypt10n}')
    expect(body).toContain('"flag": "flag{b4s3_64_1s_n0t_3ncrypt10n}"')
    expect(body).toContain('"stoppedReason": "flag_found"')
  })

  it('returns no flag when input is not multi-layer encoded', async () => {
    const tool = createCTFUtilTools().find((t) => t.name === 'decode_tree')
    const result = await tool!.execute(
      { text: 'plain ascii text without any encoding chain', flagPattern: 'flag\\{[^}]+\\}', maxDepth: 2 },
      TOOL_CTX,
    )
    expect(result.isError).toBe(false)
    expect(result.content).not.toContain('flag{')
  })
})
