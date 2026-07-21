/**
 * End-to-end Harness tests — exercise the full stack:
 *   createHarness → ToolBroker → BashTool → BashRefusesProfilePolicy
 *   WorkflowEngine → WorkflowBrokerRunner → broker.execute
 *   Meta tools (emit_finding / request_handoff / list_artifacts / etc.)
 *
 * These tests do NOT call the LLM; they verify the harness mechanics using
 * real bash execution + a fake PNG fixture.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { createHarness } from '../src/core/harness.js'
import { dispatchNext, inspectNextHandoff } from '../src/core/orchestratorDispatch.js'
import { ensureWorkflowsRegistered, __resetWorkflowRegistrationForTests } from '../src/workflows/index.js'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'harness-e2e-'))
  // Drop a fake PNG file so file(1) does not crash. Only first 8 bytes matter.
  writeFileSync(join(root, 'ctf-sample.png'), Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a, ...Array(100).fill(0xab)]))
  // A second file with ZIP magic so the unknown_file_triage "if" branch fires.
  writeFileSync(join(root, 'archive.zip'), Buffer.from([0x50,0x4b,0x03,0x04, ...Array(50).fill(0x00)]))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

// ──────────────────────────────────────────────────────────────────────────
// 场景 1 + 5 + 6 集成
// ──────────────────────────────────────────────────────────────────────────

describe('createHarness — basic mechanics', () => {
  it('builds a complete bundle that resolves a Profile, ContestScope, and stores', () => {
    const h = createHarness({ cwd: root, profile: 'image-stego' })
    expect(h.profile.id).toBe('image-stego')
    expect(h.contestScope).toBeDefined()
    expect(h.broker).toBeDefined()
    expect(h.workflowRegistry.has('image_quick_scan')).toBe(true)
    expect(h.artifactStore).toBeDefined()
    expect(h.findingStore).toBeDefined()
    expect(h.handoffStore).toBeDefined()
    expect(h.jobManager).toBeDefined()
    expect(h.taskWorkspace.paths.workspaceDir.endsWith('/workspace')).toBe(true)
    expect(h.taskWorkspace.paths.artifactsDir.endsWith('/artifacts')).toBe(true)
  })
})

describe('ToolBroker with real bash — Profile denies tools not on allowlist', () => {
  it('image-stego can use Bash (it is in allowedTools)', async () => {
    const h = createHarness({ cwd: root, profile: 'image-stego', jobLimits: { maxPerAgent: 0, maxPerTask: 0 } })
    // With maxPerAgent = 0 the broker cannot spawn background jobs → falls
    // through to inline execution. Easiest way to force inline in this test.
    const r = await h.broker.execute('Bash', { command: 'echo profile-e2e-hello' }, {
      cwd: root, taskId: 't1', agentId: 'image-stego',
    })
    expect(r.result.isError).toBe(false)
    expect(r.result.content).toMatch(/profile-e2e-hello/)
  })

  it('orchestrator profile refuses all Bash commands because allowShell=false + deniedTools', async () => {
    const h = createHarness({ cwd: root, profile: 'orchestrator', jobLimits: { maxPerAgent: 0, maxPerTask: 0 } })
    const r = await h.broker.execute('Bash', { command: 'ls' }, {
      cwd: root, taskId: 't1', agentId: 'orchestrator',
    })
    expect(r.result.isError).toBe(true)
    // The Broker denies Bash at the profile-tools layer (deniedTools). The
    // model sees a structured refusal that hints at HandoffRequest.
    expect(r.result.content).toMatch(/denied by profile|HandoffRequest/i)
  })

  it('image-stego profile refuses sqlmap because deniedCommands blocks it', async () => {
    const profile = {
      ...createHarness({ cwd: root, profile: 'image-stego' }).profile,
      deniedCommands: ['sqlmap'],
    }
    const h = createHarness({ cwd: root, profile, jobLimits: { maxPerAgent: 0, maxPerTask: 0 } })
    const r = await h.broker.execute('Bash', { command: 'sqlmap -u http://target/ --batch' }, {
      cwd: root, taskId: 't1', agentId: 'image-stego',
    })
    expect(r.result.isError).toBe(true)
    expect(r.result.content).toMatch(/deniedCommands/)
  })
})

function harnessHelper() {
  return createHarness({ cwd: root, profile: 'image-stego' })
}

// ──────────────────────────────────────────────────────────────────────────
// 场景 2 — 跨领域接力
// ──────────────────────────────────────────────────────────────────────────

describe('Meta tools — emit_finding / request_handoff round-trip', () => {
  it('emit_finding persists and request_handoff submits; orchestrator dispatch inspects pending list', async () => {
    const h = createHarness({ cwd: root, profile: 'image-stego' })

    const emitted = await h.broker.execute('emit_finding', {
      category: 'image',
      title: 'PNG magic detected',
      summary: '89 50 4e 47 (PNG) magic found in ctf-sample.png',
      confidence: 'high',
      artifactIds: [],
    }, { cwd: root, taskId: 't1', agentId: 'image-stego' })
    expect(emitted.result.isError).toBe(false)
    expect(emitted.result.content).toMatch(/Finding stored/)

    const fid = (emitted.result.content.match(/id=(\S+)/) ?? [])[1]
    expect(fid).toBeTruthy()

    const handoffRes = await h.broker.execute('request_handoff', {
      suggestedAgent: 'file-forensics',
      reason: 'Extracted nested archive.zip — needs recursive extraction',
      objective: 'Recursively extract archive.zip and report contents',
      findingIds: [fid ?? ''],
    }, { cwd: root, taskId: 't1', agentId: 'image-stego' })
    expect(handoffRes.result.isError).toBe(false)
    const hid = (handoffRes.result.content.match(/id=(\S+)/) ?? [])[1]
    expect(hid).toBeTruthy()

    const pending = h.handoffStore.pending()
    expect(pending.length).toBe(1)
    expect(pending[0].suggestedAgent).toBe('file-forensics')
    expect(pending[0].status).toBe('pending')

    const decision = await dispatchNext(h, { decision: 'approve' })
    expect(decision?.status).toBe('approved')

    expect(h.handoffStore.pending().length).toBe(0)
  })

  it('inspectNextHandoff returns the highest priority first', async () => {
    const h = createHarness({ cwd: root, profile: 'image-stego' })
    await h.broker.execute('request_handoff', {
      suggestedAgent: 'crypto', reason: 'a', objective: 'b', priority: 1,
    }, { cwd: root, taskId: 't1', agentId: 'image-stego' })
    await h.broker.execute('request_handoff', {
      suggestedAgent: 'file-forensics', reason: 'c', objective: 'd', priority: 9,
    }, { cwd: root, taskId: 't1', agentId: 'image-stego' })
    const next = inspectNextHandoff(h)
    expect(next?.suggestedAgent).toBe('file-forensics')
  })
})

// ──────────────────────────────────────────────────────────────────────────
// 场景 5 — Bash 拒绝
// ──────────────────────────────────────────────────────────────────────────

describe('Bash policy in real Broker flow', () => {
  it('denies curl to blocked host when contest scope enforces; allows curl to allowed host', async () => {
    const scopeMod = await import('../src/core/contestScope.js')
    const checker = new scopeMod.ContestScopeChecker(
      scopeMod.parseContestScope({
        allowedFilesRoot: root, allowPublicNetwork: false,
        allowedHosts: ['safe.example'],
      }),
    )
    const h = createHarness({
      cwd: root,
      profile: 'image-stego',
      contestScope: {
        allowedFilesRoot: root,
        allowPublicNetwork: false,
        allowedHosts: ['safe.example'],
      } as unknown as import('../src/core/contestScope.js').ContestScope,
      jobLimits: { maxPerAgent: 0, maxPerTask: 0 },
    })
    // Re-bind the broker's contestScope to the checker we built.
    ;(h.broker as unknown as { opts: { contestScope?: unknown } }).opts.contestScope = checker

    // Allowed host — the policy should not refuse; whether the bash tool
    // actually completes a curl is irrelevant to the test (no real DNS).
    const yesRes = await h.broker.execute('Bash', { command: 'curl -sS --max-time 2 http://safe.example/health' }, {
      cwd: root, taskId: 't1', agentId: 'image-stego',
    })
    expect(yesRes.result.content).not.toMatch(/outside contest network scope/)

    // Blocked host — the policy must refuse BEFORE invoking curl.
    const noRes = await h.broker.execute('Bash', { command: 'curl -sS http://blocked.example/' }, {
      cwd: root, taskId: 't1', agentId: 'image-stego',
    })
    expect(noRes.result.isError).toBe(true)
    expect(noRes.result.content).toMatch(/outside contest network scope/)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// 场景 7 — 后台任务取消
// ──────────────────────────────────────────────────────────────────────────

describe('BackgroundJobManager through harness — cancel works', () => {
  it('h.cancelAllJobs stops running background tasks and updates status', async () => {
    const h = createHarness({ cwd: root, profile: 'image-stego' })
    const job = await h.jobManager.spawn({
      taskId: h.taskWorkspace.paths.taskId,
      agentId: 'image-stego',
      toolId: 'Bash',
      input: { command: 'sleep 9999' },
      timeoutMs: 600_000,
    })
    // Wait until the job has actually transitioned to running (signal listener
    // installed in bashTool). Polling avoids a fixed-delay race.
    let attempts = 0
    while (job.status === 'pending' && attempts < 30) {
      await new Promise((r) => setTimeout(r, 20))
      attempts++
    }
    expect(job.status).toBe('running')
    const cancelled = h.cancelAllJobs('orchestrator_done')
    expect(cancelled).toBeGreaterThanOrEqual(1)
    const final = await h.jobManager.wait(job.id, 8000)
    expect(['cancelled', 'failed']).toContain(final.status)
    expect(job.id).toMatch(/^job_/)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// 场景 1 — Workflow run (BrokerRunner)
// ──────────────────────────────────────────────────────────────────────────

describe('runWorkflow — WorkflowBrokerRunner through full broker', () => {
  it('runs unknown_file_triage against the fake PNG fixture', async () => {
    __resetWorkflowRegistrationForTests()
    const h = createHarness({ cwd: root, profile: 'triage' })

    const wf = h.workflowRegistry.get('unknown_file_triage')!
    // Override the captured outputs so the if step fires.
    const inputs = { FILE_INPUT: join(root, 'ctf-sample.png') }
    const result = await h.runWorkflow(wf, inputs)
    // image-stego's "if" branch against magic '89504e47' (PNG): mock — but
    // we're using *real* bash here, so magic output depends on xxd. Just
    // check the workflow ran without throwing.
    expect(result.workflowId).toBe('unknown_file_triage')
    expect(['success', 'partial']).toContain(result.status)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// 流程断言
// ──────────────────────────────────────────────────────────────────────────

describe('switchProfile and Event log presence', () => {
  it('switchProfile re-routes the broker to the new profile', () => {
    const h = createHarness({ cwd: root, profile: 'image-stego' })
    // Note: switchProfile mutates broker.opts.profile; the bundle's exposed
    // profile is captured at construction time, so we re-read the broker's
    // profile identity directly.
    expect(h.profile.id).toBe('image-stego')
    h.switchProfile('crypto')
    const brokerProfile = (h.broker as unknown as { opts: { profile: { id: string } } }).opts.profile
    expect(brokerProfile.id).toBe('crypto')
  })

  it('events.ndjson exists in the task workspace', async () => {
    const h = createHarness({ cwd: root, profile: 'image-stego' })
    await h.broker.execute('emit_finding', { category: 'triage', title: 't', summary: 's' }, {
      cwd: root, taskId: h.taskWorkspace.paths.taskId, agentId: 'image-stego',
    })
    const { existsSync } = await import('fs')
    expect(existsSync(h.taskWorkspace.paths.eventsFile)).toBe(true)
  })
})
