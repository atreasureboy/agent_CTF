import { describe, expect, it } from 'vitest'

import {
  ChallengePromptCompiler,
  CompilerValidator,
  ProgressCompiler,
  RetryHandoffCompiler,
  SolverBriefCompiler,
  SpecialistContextCompiler,
} from '../src/core/contextCompiler/index.js'

describe('ContextCompiler Suite', () => {
  const sampleInput = {
    taskId: 'task-comp-1',
    stateRevision: 4,
    stateSnapshotHash: 'sha_abc123',
    objective: 'Extract flag from binary',
    scopeSummary: 'Target host 127.0.0.1:8080 only',
    evidences: [
      { id: 'ev_1', title: 'HTTP 200', factSummary: 'Server runs Nginx', confidence: 0.9, confirmed: true },
    ],
    hypotheses: [
      { id: 'hyp_1', title: 'SQL Injection in /login', status: 'active' as const },
    ],
    attempts: [
      { id: 'att_1', actionSummary: 'GET /login?user=admin', fingerprint: 'fp_sql_1', outcome: 'failed' },
    ],
    artifacts: [
      { id: 'art_1', path: '/tmp/app.py', description: 'web app source code' },
    ],
    allowedToolIds: ['http_request', 'python_exec'],
  }

  it('generates valid M3 XML SolverBrief', () => {
    const brief = SolverBriefCompiler.compileM3Brief(sampleInput, 'm3-mini')
    expect(brief.renderedText).toContain('<task>')
    expect(brief.renderedText).toContain('<objective>Extract flag from binary</objective>')
    expect(brief.renderedText).toContain('<fingerprint>fp_sql_1</fingerprint>')
  })

  it('falls back to deterministic template if validator fails', () => {
    const invalidCtx = ChallengePromptCompiler.compile(sampleInput, 'gpt-4o', 'solver_scout', true)
    const val = CompilerValidator.validate(invalidCtx)
    expect(val.valid).toBe(true)
    expect(invalidCtx.renderedText).toBeTruthy()
  })

  it('compiles progress brief without self-summarization', () => {
    const progress = ProgressCompiler.compileProgress(sampleInput, 'm3-mini')
    expect(progress.renderedText).toContain('PROGRESS BRIEF')
    expect(progress.sourceIds).toContain('ev_1')
  })

  it('compiles retry handoff with commands and artifacts', () => {
    const retry = RetryHandoffCompiler.compileRetryHandoff(
      sampleInput,
      {
        reproducibleCommands: ['python3 extract.py'],
        environmentDependencies: ['python3-pwntools'],
        resumeEntryPoint: 'Analyze /tmp/app.py LSB',
      },
      'gpt-4o',
    )
    expect(retry.renderedText).toContain('RETRY / RESUME HANDOFF BRIEF')
    expect(retry.renderedText).toContain('python3 extract.py')
  })

  it('restricts Specialist context to domain relevant items', () => {
    const specialist = SpecialistContextCompiler.compileSpecialistContext(sampleInput, 'web', 'gpt-4o')
    expect(specialist.renderedText).toContain('SPECIALIST BRIEF: WEB')
  })
})
