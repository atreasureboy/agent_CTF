import type OpenAI from 'openai'
import type { ModelHealthStore } from './modelHealth.js'
import type { ModelCircuitBreaker } from './modelCircuitBreaker.js'

export class MonitoredAgentTurnStream implements AsyncIterable<OpenAI.Chat.ChatCompletionChunk> {
  private innerStream: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>
  private modelId: string
  private taskId: string
  private healthStore: ModelHealthStore
  private circuitBreaker: ModelCircuitBreaker
  private chunkCount = 0
  private hasContent = false
  private isFinished = false
  private isCancelled = false

  constructor(
    innerStream: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>,
    modelId: string,
    taskId: string,
    healthStore: ModelHealthStore,
    circuitBreaker: ModelCircuitBreaker,
  ) {
    this.innerStream = innerStream
    this.modelId = modelId
    this.taskId = taskId
    this.healthStore = healthStore
    this.circuitBreaker = circuitBreaker
  }

  public hasExposedChunks(): boolean {
    return this.chunkCount > 0
  }

  public async *[Symbol.asyncIterator](): AsyncIterator<OpenAI.Chat.ChatCompletionChunk> {
    await Promise.resolve()
    const iterator = (this.innerStream as any)[Symbol.asyncIterator]
      ? (this.innerStream as any)[Symbol.asyncIterator]()
      : (this.innerStream as any)

    try {
      while (true) {
        const { value, done } = await iterator.next()
        if (done) {
          this.isFinished = true
          if (!this.hasContent && this.chunkCount === 0) {
            this.healthStore.recordFailure(
              this.modelId,
              'empty',
              'empty_response: zero chunks yielded before EOF',
              this.taskId,
            )
          } else {
            this.healthStore.recordSuccess(this.modelId, this.taskId)
            this.circuitBreaker.recordProbeSuccess(this.modelId)
          }
          break
        }

        this.chunkCount++
        if (value?.choices?.[0]?.delta?.content || value?.choices?.[0]?.delta?.tool_calls) {
          this.hasContent = true
        }

        yield value
      }
    } catch (err: any) {
      if (this.isCancelled) {
        // Consumer cancelled, do not record model health failure
      } else {
        const failureKind = this.chunkCount === 0 ? 'first_token_timeout' : 'stream_interrupted'
        this.healthStore.recordFailure(
          this.modelId,
          'provider',
          `${failureKind}: ${err.message}`,
          this.taskId,
        )
      }
      throw err
    } finally {
      if (!this.isFinished && !this.isCancelled) {
        // Consumer exited early before EOF
        this.isCancelled = true
        if (typeof iterator.return === 'function') {
          try {
            await iterator.return()
          } catch {
            // ignore return errors
          }
        }
      }
    }
  }
}
