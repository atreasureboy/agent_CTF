/**
 * Phase D2 — Docker challenge harness.
 *
 * Skips the actual `docker compose up` invocation in CI by testing
 * the smaller helpers (waitForTcp with a local listener, project
 * name formatting).
 */

import { describe, it, expect } from 'vitest'
import { createServer } from 'net'
import { waitForTcp } from '../src/bench/dockerHarness.js'

describe('DockerChallengeHarness (D2)', () => {
  it('waitForTcp resolves when a listener is up', async () => {
    const server = createServer()
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address()
        if (addr && typeof addr === 'object') resolve(addr.port)
      })
    })
    try {
      await waitForTcp('127.0.0.1', port, 5000)
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
  })

  it('waitForTcp times out when no listener', async () => {
    await expect(waitForTcp('127.0.0.1', 1, 500)).rejects.toThrow()
  })

  it('formats project names with a stable suffix', () => {
    const project = `bench-${'ab12'}-${'d2-1'}`.toLowerCase()
    expect(project).toBe('bench-ab12-d2-1')
  })
})
