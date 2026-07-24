import { describe, expect, it } from 'vitest'
import { createCTFTaskRuntime } from '../src/core/ctfRuntime/createCTFTaskRuntime.js'

describe('Runtime Integration Phase 3.0', () => {
  it('wires Phase 3.0 reliability, portfolio and tool visibility onto CTFTaskRuntime instance', async () => {
    const runtime = await createCTFTaskRuntime({
      cwd: process.cwd(),
      profileId: 'orchestrator',
      mode: 'workflow-only',
    })

    expect(runtime.modelReliability).toBeDefined()
    expect(runtime.modelReliability?.registry).toBeDefined()
    expect(runtime.modelReliability?.gateway).toBeDefined()
    expect(runtime.solverPortfolio).toBeDefined()
    expect(runtime.toolVisibilityPolicy).toBeDefined()

    await runtime.dispose()
  })
})
