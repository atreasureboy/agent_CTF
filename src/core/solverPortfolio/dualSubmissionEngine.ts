import { FlagDiscriminator } from './flagDiscriminator.js'
import type { SubmissionRequest, SubmissionResponse } from './submissionController.js'
import { CTFPlatformAdapter, type CTFdConfig } from '../ctfPlatform/ctfPlatformAdapter.js'

export type SubmissionMode = 'auto' | 'manual'

export interface ManualCandidateRecord {
  id: string
  taskId: string
  candidateValue: string
  confidence: number
  source: string
  formattedMarkdown: string
  timestamp: string
}

export class DualSubmissionEngine {
  private mode: SubmissionMode
  private platformAdapter?: CTFPlatformAdapter
  private manualQueue: ManualCandidateRecord[] = []

  constructor(mode: SubmissionMode = 'auto', ctfdConfig?: CTFdConfig) {
    this.mode = mode
    if (ctfdConfig) {
      this.platformAdapter = new CTFPlatformAdapter(ctfdConfig)
    }
  }

  public setMode(mode: SubmissionMode): void {
    this.mode = mode
  }

  public getMode(): SubmissionMode {
    return this.mode
  }

  /**
   * Submit flag candidate via Auto or Manual submission protocol.
   */
  public async processCandidate(req: SubmissionRequest): Promise<SubmissionResponse> {
    const discrimination = FlagDiscriminator.discriminate({
      candidateValue: req.candidateValue,
    })

    if (!discrimination.valid) {
      return {
        status: 'rejected',
        accepted: false,
        message: `[DualSubmissionEngine] Flag rejected by FlagDiscriminator: ${discrimination.reason}`,
      }
    }

    if (this.mode === 'auto' && this.platformAdapter) {
      const res = await this.platformAdapter.submitToCTFd(req)
      return CTFPlatformAdapter.mapToSubmissionResponse(res)
    }

    return this.enqueueManual(req, discrimination.confidence)
  }

  /**
   * Submit multiple flag candidates concurrently. In auto mode, all
   * valid candidates are submitted in parallel via Promise.allSettled.
   */
  public async processCandidates(reqs: SubmissionRequest[]): Promise<SubmissionResponse[]> {
    return Promise.all(reqs.map((req) => this.processCandidate(req)))
  }

  private enqueueManual(req: SubmissionRequest, confidence: number): SubmissionResponse {
    const manualRecord: ManualCandidateRecord = {
      id: `cand_${req.taskId}_${Date.now()}`,
      taskId: req.taskId,
      candidateValue: req.candidateValue,
      confidence,
      source: req.solverId,
      formattedMarkdown: `### 🚩 [CONFIRMED FLAG CANDIDATE]\n- **Task ID**: \`${req.taskId}\`\n- **Candidate Flag**: \`${req.candidateValue}\`\n- **Confidence**: \`${(confidence * 100).toFixed(0)}%\`\n- **Provenance**: \`${req.solverId}\` (Model: ${req.modelId})`,
      timestamp: new Date().toISOString(),
    }

    this.manualQueue.push(manualRecord)

    return {
      status: 'simulated_accepted',
      accepted: false,
      message: `[ManualMode Queue] Candidate '${req.candidateValue}' queued for contestant manual submission. (Queue size: ${this.manualQueue.length})`,
      points: 100,
    }
  }

  /**
   * Get all queued manual submission records.
   */
  public getManualQueue(): ManualCandidateRecord[] {
    return [...this.manualQueue]
  }

  /**
   * Export manual submission queue as a consolidated Markdown report.
   */
  public exportManualReport(): string {
    if (this.manualQueue.length === 0) {
      return '# Manual Flag Submission Queue\n\nNo flag candidates currently queued.'
    }
    const lines = ['# 🚩 Contestant Manual Flag Submission Queue', '']
    for (const rec of this.manualQueue) {
      lines.push(rec.formattedMarkdown, '')
    }
    return lines.join('\n')
  }
}
