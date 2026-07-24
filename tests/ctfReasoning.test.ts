import { createNoopStrategyActionExecutor } from '../src/core/ctfReasoning/runtimeStrategyActionExecutor.js'
/**
 * Phase 2.2 — Reasoning layer tests.
 *
 * Covers: Observation, Evidence (multi-source), AttemptFingerprint,
 * AttemptDeduplicator, parsers, workflow condition evaluator, strategy
 * planner, flag detector.
 */

import { describe, it, expect } from 'vitest'
import { createObservation, observationFingerprint } from '../src/core/ctfReasoning/observation.js'
import {
  createEvidence,
  mergeEvidence,
  evidenceFingerprint,
  combineIndependentConfidences,
  normalizeClaim,
} from '../src/core/ctfReasoning/evidence.js'
import { createAttemptFingerprint } from '../src/core/ctfReasoning/attemptFingerprint.js'
import { createAttemptDeduplicator } from '../src/core/ctfReasoning/attemptDeduplicator.js'
import { detectFlag, validateFlag } from '../src/core/ctfReasoning/flagCandidateValidator.js'
import { evaluateWorkflowCondition } from '../src/core/ctfReasoning/workflowCondition.js'
import { planStrategy } from '../src/core/ctfReasoning/strategyPlanner.js'
import { getDefaultParserRegistry, materializeViaRegistry } from '../src/core/ctfReasoning/parserRegistry.js'
import type { CTFTaskState } from '../src/core/ctfRuntime/taskState.js'
import { processNewReasoningInputs } from '../src/core/ctfReasoning/reasoningCoordinator.js'
import { CTFTaskStateStore } from '../src/core/ctfRuntime/taskStateStore.js'
import {
  DEFAULT_REASONING_BUDGET_LIMITS,
  createInitialReasoningBudgetState,
} from '../src/core/ctfReasoning/reasoningBudget.js'

function emptyState(taskId = 't1'): CTFTaskState {
  return {
    taskId,
    phase: 'triage',
    context: {
      taskId,
      workspaceDir: '/tmp/ctf',
      sessionDir: '/tmp/ctf/s',
      artifactDir: '/tmp/ctf/a',
      inputDir: '/tmp/ctf/i',
      eventsFile: '/tmp/ctf/e.ndjson',
      profileId: 'triage',
      contestScope: { allowedFilesRoot: '/tmp/ctf', allowPublicNetwork: false, allowHeavyOneShots: false },
      contestConfig: { allowedFilesRoot: '/tmp/ctf', allowPublicNetwork: false, allowHeavyOneShots: false },
      environment: {},
      abortSignal: new AbortController().signal,
      metadata: {},
    },
    challenge: { inputArtifactIds: [] },
    activeProfileId: 'triage',
    findings: [],
    artifactIds: [],
    hypotheses: [],
    attempts: [],
    handoffs: [],
    agentRuns: [],
    workflowRuns: [],
    jobs: [],
    oneShotRuns: [],
    activeAgentRunIds: [],
    activeWorkflowRunIds: [],
    activeJobIds: [],
    observations: [],
    evidence: [],
    strategyDecisions: [],
    pendingActions: [],
    reasoningBudget: createInitialReasoningBudgetState(),
    reasoningBudgetLimits: DEFAULT_REASONING_BUDGET_LIMITS,
    flagCandidates: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

describe('Observation', () => {
  it('rejects empty taskId', () => {
    expect(() => createObservation('', {
      kind: 'generic',
      source: { type: 'tool' },
      summary: 'x',
      confidence: 0.5,
    })).toThrow()
  })
  it('rejects confidence outside [0, 1]', () => {
    expect(() => createObservation('t', {
      kind: 'generic',
      source: { type: 'tool' },
      summary: 'x',
      confidence: 1.5,
    })).toThrow()
  })
  it('truncates raw excerpt to MAX_RAW_EXCERPT', () => {
    const big = 'x'.repeat(2048)
    const obs = createObservation('t', {
      kind: 'generic',
      source: { type: 'tool' },
      summary: 'big',
      confidence: 0.5,
      rawExcerpt: big,
    })
    expect(obs.rawExcerpt?.length).toBe(1024)
  })
  it('fingerprint stable for identical inputs', () => {
    const a = createObservation('t', { kind: 'printable_text', source: { type: 'tool' }, summary: 'x', confidence: 0.5 })
    const b = createObservation('t', { kind: 'printable_text', source: { type: 'tool' }, summary: 'x', confidence: 0.5 })
    expect(observationFingerprint(a)).toBe(observationFingerprint(b))
  })
})

describe('Evidence — Phase 2.2 §十五 multi-source', () => {
  it('refuses missing producer', () => {
    expect(() => createEvidence('t', {
      kind: 'generic', claim: 'c',
      source: {
        producer: { type: 'parser', id: '' }, observationIds: [], artifactIds: [], attemptIds: [],
        confidence: 0.5, createdAt: 0,
      },
    })).toThrow()
  })
  it('fingerprint excludes producer so two parsers converge', () => {
    const a = evidenceFingerprint({ taskId: 't', kind: 'generic', claim: 'file is PNG', polarity: 'supports' })
    const b = evidenceFingerprint({ taskId: 't', kind: 'generic', claim: 'file is PNG', polarity: 'supports' })
    expect(a).toBe(b)
  })
  it('merges sources and unions observation/artifact/attempt ids', () => {
    const a = createEvidence('t', {
      kind: 'file_signature', claim: 'file is PNG',
      source: {
        producer: { type: 'parser', id: 'file' }, observationIds: ['o1'], artifactIds: ['art1'], attemptIds: [],
        confidence: 0.85, createdAt: 0,
      },
    })
    const b = createEvidence('t', {
      kind: 'file_signature', claim: 'file is PNG',
      source: {
        producer: { type: 'parser', id: 'hex' }, observationIds: ['o2'], artifactIds: ['art1'], attemptIds: [],
        confidence: 0.98, createdAt: 0,
      },
    })
    const merged = mergeEvidence(a, b)
    expect(merged.sources.length).toBe(2)
    expect(merged.confidence).toBeGreaterThanOrEqual(0.98)
    expect(merged.confidence).toBeLessThanOrEqual(0.99)
  })
  it('combineIndependentConfidences bounded at 0.99', () => {
    const v = combineIndependentConfidences([
      { producer: { type: 'parser', id: 'a' }, observationIds: [], artifactIds: [], attemptIds: [], confidence: 0.99, createdAt: 0 },
      { producer: { type: 'parser', id: 'b' }, observationIds: [], artifactIds: [], attemptIds: [], confidence: 0.99, createdAt: 0 },
    ])
    expect(v).toBeLessThanOrEqual(0.99)
  })
  it('normalizedClaim whitespace + case insensitive', () => {
    expect(normalizeClaim('  File IS PNG  ')).toBe('file is png')
  })
})

describe('AttemptFingerprint', () => {
  it('stable for equivalent inputs', () => {
    const a = createAttemptFingerprint({ kind: 'tool', targetId: 't1', parameters: { a: 1, b: 2 } })
    const b = createAttemptFingerprint({ kind: 'tool', targetId: 't1', parameters: { b: 2, a: 1 } })
    expect(a).toBe(b)
  })
  it('different for different parameters', () => {
    const a = createAttemptFingerprint({ kind: 'tool', targetId: 't1', parameters: { a: 1 } })
    const b = createAttemptFingerprint({ kind: 'tool', targetId: 't1', parameters: { a: 2 } })
    expect(a).not.toBe(b)
  })
  it('redacts sensitive keys', () => {
    const a = createAttemptFingerprint({ kind: 'tool', targetId: 't1', parameters: { API_KEY: 'secret-123' } })
    const b = createAttemptFingerprint({ kind: 'tool', targetId: 't1', parameters: { API_KEY: 'different-secret-456' } })
    expect(a).toBe(b)
  })
})

describe('AttemptDeduplicator', () => {
  it('allows first attempt', () => {
    const dedup = createAttemptDeduplicator()
    const d = dedup.check({ kind: 'tool', targetId: 't1', input: { a: 1 } }, emptyState())
    expect(d.allowed).toBe(true)
  })
  it('blocks succeeded duplicates', () => {
    const state = emptyState()
    const fp = createAttemptFingerprint({ kind: 'tool', targetId: 't1', parameters: { a: 1 } })
    state.attempts = [{
      id: 'a1', taskId: 't1', kind: 'tool', targetId: 't1', input: { a: 1 },
      fingerprint: fp, hypothesisIds: [], status: 'succeeded',
      observationIds: [], evidenceIds: [], artifactIds: [], flagCandidateIds: [], createdAt: 0,
    }]
    const dedup = createAttemptDeduplicator()
    const d = dedup.check({ kind: 'tool', targetId: 't1', input: { a: 1 } }, state)
    expect(d.allowed).toBe(false)
    expect(d.reason).toBe('already_succeeded')
  })
  it('permits override with reason', () => {
    const state = emptyState()
    const fp = createAttemptFingerprint({ kind: 'tool', targetId: 't1', parameters: { a: 1 } })
    state.attempts = [{
      id: 'a1', taskId: 't1', kind: 'tool', targetId: 't1', input: { a: 1 },
      fingerprint: fp, hypothesisIds: [], status: 'succeeded',
      observationIds: [], evidenceIds: [], artifactIds: [], flagCandidateIds: [], createdAt: 0,
    }]
    const dedup = createAttemptDeduplicator()
    const d = dedup.check({ kind: 'tool', targetId: 't1', input: { a: 1 }, overrideReason: 'manual retry' }, state)
    expect(d.allowed).toBe(true)
    expect(d.overrideRecorded).toBe(true)
  })
})

describe('FlagDetector / Validator', () => {
  it('detects standard flag format', () => {
    const r = detectFlag({
      text: 'the answer is flag{test_flag_123}',
      sourceObservationIds: ['o1'],
      sourceEvidenceIds: [],
      sourceArtifactIds: [],
      sourceRunIds: [],
      producer: { type: 'parser', id: 'strings' },
    })
    expect(r.detected).toBe(true)
    expect(r.draft?.value).toBe('flag{test_flag_123}')
  })
  it('rejects when no flag in text', () => {
    const r = detectFlag({
      text: 'just plain text',
      sourceObservationIds: [],
      sourceEvidenceIds: [],
      sourceArtifactIds: [],
      sourceRunIds: [],
      producer: { type: 'parser', id: 'strings' },
    })
    expect(r.detected).toBe(false)
  })
  it('validator: requires all three gates', () => {
    const v = validateFlag({ pattern: 'flag\\{[^}]+\\}', candidate: 'flag{ok}', provenanceComplete: true, sourceArtifactExists: true, locallyVerified: true })
    expect(v.validated).toBe(true)
    const v2 = validateFlag({ pattern: 'flag\\{[^}]+\\}', candidate: 'flag{ok}', provenanceComplete: false, sourceArtifactExists: true, locallyVerified: true })
    expect(v2.validated).toBe(false)
    expect(v2.errors).toContain('provenance incomplete')
  })

  it('validator: pattern mismatch flags an error', () => {
    const v = validateFlag({ pattern: 'ctf\\{[^}]+\\}', candidate: 'flag{ok}', provenanceComplete: true, sourceArtifactExists: true, locallyVerified: true })
    expect(v.validated).toBe(false)
    expect(v.errors).toContain('pattern mismatch')
  })
})

describe('WorkflowCondition evaluator', () => {
  const state = emptyState()
  state.observations = [
    { id: 'o1', taskId: 't1', kind: 'file_type', source: { type: 'tool' }, summary: 'PNG', attributes: { ext: 'png' }, confidence: 0.9, createdAt: 0 },
  ]
  state.evidence = [
    {
      id: 'e1', taskId: 't1', kind: 'file_signature', claim: 'PNG image',
      claimFamily: 'file_type',
      normalizedClaim: 'png image', polarity: 'supports', confidence: 0.9,
      sources: [{ producer: { type: 'parser', id: 'file' }, observationIds: ['o1'], artifactIds: [], attemptIds: [], confidence: 0.9, createdAt: 0 }],
      fingerprint: 'fp', attributes: {}, createdAt: 0, updatedAt: 0,
    },
  ]
  state.attempts = [{
    id: 'a1', taskId: 't1', kind: 'tool', targetId: 'binwalk', input: {},
    fingerprint: 'fp_a1', hypothesisIds: [], status: 'succeeded',
    observationIds: [], evidenceIds: [], artifactIds: [], flagCandidateIds: [], createdAt: 0,
  }]

  it('evaluates observation_exists', () => {
    expect(evaluateWorkflowCondition(
      { type: 'observation_exists', kind: 'file_type' },
      { state: { ...state }, stepOutcomes: new Map() },
    )).toBe(true)
  })
  it('evaluates evidence_exists with polarity', () => {
    expect(evaluateWorkflowCondition(
      { type: 'evidence_exists', kind: 'file_signature', polarity: 'supports' },
      { state: { ...state }, stepOutcomes: new Map() },
    )).toBe(true)
  })
  it('evaluates attempt_exists with fingerprint', () => {
    expect(evaluateWorkflowCondition(
      { type: 'attempt_exists', fingerprint: 'fp_a1' },
      { state: { ...state }, stepOutcomes: new Map() },
    )).toBe(true)
  })
  it('evaluates all / any / not', () => {
    expect(evaluateWorkflowCondition(
      { type: 'all', conditions: [
        { type: 'observation_exists', kind: 'file_type' },
        { type: 'evidence_exists', kind: 'file_signature' },
      ] },
      { state: { ...state }, stepOutcomes: new Map() },
    )).toBe(true)
    expect(evaluateWorkflowCondition(
      { type: 'not', condition: { type: 'observation_exists', kind: 'binary_protection' } },
      { state: { ...state }, stepOutcomes: new Map() },
    )).toBe(true)
  })
  it('conservative false on missing field', () => {
    expect(evaluateWorkflowCondition(
      { type: 'observation_exists', kind: 'metadata' },
      { state: { ...state }, stepOutcomes: new Map() },
    )).toBe(false)
  })
  it('scope-restricts evidence_exists to a producerId filter (§十二)', () => {
    const liveState = emptyState()
    liveState.evidence = [
      { id: 'e1', taskId: 't1', kind: 'file_signature', claim: 'PNG',
        claimFamily: 'file_type',
        normalizedClaim: 'png', polarity: 'supports',
        confidence: 0.9,
        sources: [{ producer: { type: 'parser', id: 'hex' }, observationIds: [], artifactIds: [], attemptIds: [], confidence: 0.9, createdAt: 0 }],
        fingerprint: 'fp1', attributes: {}, createdAt: 0, updatedAt: 0 },
    ]
    // A condition that requires the source producer to be 'file' will
    // not match because the evidence was produced by 'hex'.
    expect(evaluateWorkflowCondition(
      { type: 'evidence_exists', kind: 'file_signature', scope: { producerId: 'file' } },
      { state: liveState, stepOutcomes: new Map() },
    )).toBe(false)
  })
})

describe('StrategyPlanner', () => {
  const limits = { fastConcurrency: 1, mediumConcurrency: 1, heavyConcurrency: 1, perTaskMaxRuns: 100, perTaskHeavyRuns: 1 }
  it('selects highest-priority action', () => {
    const state = emptyState()
    const decision = planStrategy({
      state,
      newObservationIds: [],
      newEvidenceIds: [],
      suggestedActions: [
        { type: 'call_tool', toolId: 'low', input: {}, reason: 'low prio', priority: 1, costTier: 'cheap' },
        { type: 'run_workflow', workflowId: 'high', inputs: {}, reason: 'high prio', priority: 9, costTier: 'cheap' },
      ],
      cost: { limits, currentSpend: { fast: 0, medium: 0, heavy: 0 }, heavyApproved: false, taskTerminal: false },
      budget: { state: createInitialReasoningBudgetState(), limits: DEFAULT_REASONING_BUDGET_LIMITS, heavyApproved: false },
    })
    expect(decision.selectedAction?.type).toBe('run_workflow')
    expect(decision.basedOnHypothesisIds).toBeDefined()
  })
  it('returns stop when task terminal', () => {
    const state = emptyState()
    state.completion = { status: 'failed', reason: 'done', decidedAt: 0 }
    const decision = planStrategy({
      state,
      newObservationIds: [],
      newEvidenceIds: [],
      suggestedActions: [{ type: 'call_tool', toolId: 't', input: {}, reason: 'r', priority: 1, costTier: 'cheap' }],
      cost: { limits, currentSpend: { fast: 0, medium: 0, heavy: 0 }, heavyApproved: false, taskTerminal: true },
      budget: { state: createInitialReasoningBudgetState(), limits: DEFAULT_REASONING_BUDGET_LIMITS, heavyApproved: false },
    })
    expect(decision.selectedAction).toBeUndefined()
  })
  it('blocks expensive action when heavy not approved', () => {
    const state = emptyState()
    const decision = planStrategy({
      state,
      newObservationIds: [],
      newEvidenceIds: [],
      suggestedActions: [{ type: 'call_tool', toolId: 't', input: {}, reason: 'r', priority: 5, costTier: 'expensive' }],
      cost: { limits, currentSpend: { fast: 0, medium: 0, heavy: 0 }, heavyApproved: false, taskTerminal: false },
      budget: { state: createInitialReasoningBudgetState(), limits: DEFAULT_REASONING_BUDGET_LIMITS, heavyApproved: false },
    })
    expect(decision.selectedAction).toBeUndefined()
    expect(decision.rejectedActions[0]?.reason).toBe('budget_denied')
  })
  it('honours stop action (§四)', () => {
    const state = emptyState()
    const decision = planStrategy({
      state,
      newObservationIds: [],
      newEvidenceIds: [],
      suggestedActions: [{ type: 'stop', reason: 'manual stop', priority: 1, costTier: 'cheap' }],
      cost: { limits, currentSpend: { fast: 0, medium: 0, heavy: 0 }, heavyApproved: false, taskTerminal: false },
      budget: { state: createInitialReasoningBudgetState(), limits: DEFAULT_REASONING_BUDGET_LIMITS, heavyApproved: false },
    })
    expect(decision.selectedAction).toBeUndefined()
    expect(decision.reason).toContain('stop')
  })
  it('populates basedOnHypothesisIds from action.hypothesisIds (§十)', () => {
    const state = emptyState()
    state.hypotheses = [
      { id: 'h1', taskId: 't1', statement: 'file is image', category: 'file-type', status: 'proposed', supportingEvidenceIds: [], contradictingEvidenceIds: [], proposedBy: { type: 'planner', id: 'p' }, priority: 5, confidence: 0.6, createdAt: 0, updatedAt: 0 },
    ]
    const decision = planStrategy({
      state,
      newObservationIds: ['o1'],
      newEvidenceIds: [],
      suggestedActions: [{ type: 'call_tool', toolId: 'file', input: {}, reason: 'classify', priority: 5, costTier: 'cheap', hypothesisIds: ['h1'] }],
      cost: { limits, currentSpend: { fast: 0, medium: 0, heavy: 0 }, heavyApproved: false, taskTerminal: false },
      budget: { state: createInitialReasoningBudgetState(), limits: DEFAULT_REASONING_BUDGET_LIMITS, heavyApproved: false },
    })
    expect(decision.selectedAction?.type).toBe('call_tool')
    expect(decision.basedOnHypothesisIds).toContain('h1')
  })
})

describe('ParserRegistry', () => {
  it('file parser detects PNG', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0])
    const r = await materializeViaRegistry(
      { toolId: 'file' },
      { taskId: 't', source: { type: 'tool', toolId: 'file' }, content: png.toString('binary'), artifactIds: [], isError: false },
    )
    expect(r.observations.find((o) => o.kind === 'file_type')?.attributes?.['ext']).toBe('png')
    expect(r.evidence.find((e) => e.kind === 'file_signature')).toBeDefined()
  })
  it('strings parser detects flag', async () => {
    const r = await materializeViaRegistry(
      { toolId: 'strings' },
      { taskId: 't', source: { type: 'tool', toolId: 'strings' }, content: 'normal text\nflag{abc_xyz}\n', artifactIds: [], isError: false },
    )
    expect(r.flagCandidateDrafts.length).toBe(1)
    expect(r.flagCandidateDrafts[0]?.value).toBe('flag{abc_xyz}')
  })
  it('binwalk parser emits embedded_archive + action', async () => {
    const r = await materializeViaRegistry(
      { toolId: 'binwalk' },
      { taskId: 't', source: { type: 'tool', toolId: 'binwalk' }, content: '0           0x0         Zip archive data\n', artifactIds: [], isError: false },
    )
    expect(r.evidence.find((e) => e.kind === 'embedded_archive')).toBeDefined()
    expect(r.suggestedActions[0]?.type).toBe('call_tool')
  })
  it('zsteg no-meaningful result → negative evidence', async () => {
    const r = await materializeViaRegistry(
      { toolId: 'zsteg' },
      { taskId: 't', source: { type: 'tool', toolId: 'zsteg' }, content: '', artifactIds: [], isError: false },
    )
    expect(r.evidence.find((e) => e.kind === 'negative_result')).toBeDefined()
  })
  it('checksec extracts arch + nx', async () => {
    const r = await materializeViaRegistry(
      { toolId: 'checksec' },
      { taskId: 't', source: { type: 'tool', toolId: 'checksec' }, content: 'RELRO:    Full RELRO\nNX:        Enabled\nPIE:       PIE enabled\n', artifactIds: [], isError: false },
    )
    const obs = r.observations.find((o) => o.kind === 'binary_protection')
    expect(obs?.attributes?.['relro']).toBe('Full RELRO')
    expect(obs?.attributes?.['nx']).toBe('Enabled')
  })
  it('encoding parser classifies base64', async () => {
    const r = await materializeViaRegistry(
      { toolId: 'encoding-detect' },
      { taskId: 't', source: { type: 'tool', toolId: 'encoding-detect' }, content: 'SGVsbG8gd29ybGQ=', artifactIds: [], isError: false },
    )
    expect(r.observations.find((o) => o.kind === 'encoding_result')?.attributes?.['codec']).toBe('base64')
  })
  it('exiftool flags long fields', async () => {
    const longVal = 'x'.repeat(500)
    const r = await materializeViaRegistry(
      { toolId: 'exiftool' },
      { taskId: 't', source: { type: 'tool', toolId: 'exiftool' }, content: `Comment: ${longVal}\nMake: Canon\n`, artifactIds: [], isError: false },
    )
    expect(r.evidence.find((e) => e.kind === 'suspicious_metadata')).toBeDefined()
  })
  it('hexHeader parser identifies magic', async () => {
    const r = await materializeViaRegistry(
      { toolId: 'hex' },
      { taskId: 't', source: { type: 'tool', toolId: 'hex' }, content: '89 50 4e 47 0d 0a 1a 0a', artifactIds: [], isError: false },
    )
    expect(r.observations.find((o) => o.kind === 'file_magic')?.summary).toBe('PNG')
  })
  it('generic parser handles arbitrary input', async () => {
    const r = await materializeViaRegistry(
      { toolId: 'unknown-tool' },
      { taskId: 't', source: { type: 'tool', toolId: 'unknown-tool' }, content: 'hello world', artifactIds: [], isError: false, exitCode: 0 },
    )
    expect(r.observations.length).toBeGreaterThan(0)
  })
})

describe('ReasoningCoordinator — Phase 2.2 §四–§八', () => {
  it('runs a bounded strategy cycle and records decisions', async () => {
    const state = emptyState('cycle-test')
    const store = new CTFTaskStateStore(state)
    const result = await processNewReasoningInputs({
      taskId: 'cycle-test',
      state,
      store,
      budgetLimits: { fastConcurrency: 1, mediumConcurrency: 1, heavyConcurrency: 1, perTaskMaxRuns: 100, perTaskHeavyRuns: 1 },
      heavyApproved: false,
      executor: {
        async execute() {
          return {
            status: 'executed',
            materializedResult: {
              observations: [
                {
                  kind: 'command_status',
                  source: { type: 'tool' as const, toolId: 'file' },
                  summary: 'completed',
                  confidence: 0.5,
                },
              ],
              evidence: [
                {
                  kind: 'file_signature' as const,
                  claim: 'tool completed',
                  polarity: 'neutral' as const,
                  source: {
                    producer: { type: 'parser' as const, id: 'tool-stub' },
                    observationIds: [], artifactIds: ['a_stub'], attemptIds: [],
                    confidence: 0.5, createdAt: 0,
                  },
                },
              ],
              suggestedActions: [],
              flagCandidateDrafts: [],
              warnings: [],
              rawArtifactIds: ['a_stub'],
            },
            executionRefs: {},
          }
        },
      },
    }, {
      source: 'main-agent',
      newObservationIds: [],
      newEvidenceIds: [],
      suggestedActions: [
        { type: 'call_tool', toolId: 'file', input: { path: 'x' }, reason: 'identify file', priority: 5, costTier: 'cheap' },
      ],
    })
    expect(result.cycles).toBeGreaterThan(0)
    expect(store.getState().observations.length).toBeGreaterThan(0)
    expect(store.getState().strategyDecisions.length).toBeGreaterThan(0)
    expect(store.getState().attempts.length).toBeGreaterThan(0)
    // §五 — Attempt binds Observation + Evidence ids on completion.
    const completedAttempt = store.getState().attempts[0]
    expect(completedAttempt?.status).toBe('succeeded')
    expect(completedAttempt?.observationIds.length).toBeGreaterThan(0)
    expect(completedAttempt?.evidenceIds.length).toBeGreaterThan(0)
  })

  it('stop Action terminates the loop (§四)', async () => {
    const state = emptyState('stop-test')
    const store = new CTFTaskStateStore(state)
    const result = await processNewReasoningInputs({
      taskId: 'stop-test',
      state,
      store,
      executor: createNoopStrategyActionExecutor(),
      budgetLimits: { fastConcurrency: 1, mediumConcurrency: 1, heavyConcurrency: 1, perTaskMaxRuns: 100, perTaskHeavyRuns: 1 },
      heavyApproved: false,
    }, {
      source: 'manual',
      newObservationIds: [],
      newEvidenceIds: [],
      suggestedActions: [
        { type: 'call_tool', toolId: 't', input: {}, reason: 'r', priority: 9, costTier: 'cheap' },
        { type: 'stop', reason: 'planner requested stop', priority: 1, costTier: 'cheap' },
      ],
    })
    expect(result.stopped).toBe(true)
    expect(result.stopReason).toContain('stop')
    // No tool Attempt for the stop action.
    const toolAttempts = store.getState().attempts.filter((a) => a.targetId === 't')
    expect(toolAttempts.length).toBe(0)
  })

  it('stops when task is terminal', async () => {
    const state = emptyState('pre-stopped')
    state.completion = { status: 'failed', reason: 'pre-stopped', decidedAt: 0 }
    const store = new CTFTaskStateStore(state)
    const result = await processNewReasoningInputs({
      taskId: 'pre-stopped',
      state,
      store,
      executor: createNoopStrategyActionExecutor(),
      budgetLimits: { fastConcurrency: 1, mediumConcurrency: 1, heavyConcurrency: 1, perTaskMaxRuns: 100, perTaskHeavyRuns: 1 },
      heavyApproved: false,
    }, {
      source: 'manual',
      newObservationIds: [],
      newEvidenceIds: [],
      suggestedActions: [],
    })
    expect(result.stopped).toBe(true)
  })
})
