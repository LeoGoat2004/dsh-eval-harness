import { describe, expect, it } from 'vitest'
import { foldMetrics, type TraceEvent } from '../packages/dsh-eval-harness/src/run/collect.ts'

const message = (usage: Record<string, number>): TraceEvent => ({
  type: 'assistant/message',
  seq: 1,
  time: 10,
  data: { turn: 1, step: 1, usage },
})

describe('foldMetrics token accounting', () => {
  it('prefers the trace total over a recomputed sum', () => {
    const metrics = foldMetrics([
      message({ inputTokens: 100, outputTokens: 200, cacheReadTokens: 300, reasoningTokens: 40, totalTokens: 640 }),
    ])
    expect(metrics.totalTokens).toBe(640)
    expect(metrics.reasoningTokens).toBe(40)
  })

  it('computes the total from parts when the trace has no total', () => {
    const metrics = foldMetrics([
      message({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 1, reasoningTokens: 3 }),
    ])
    expect(metrics.totalTokens).toBe(18)
    expect(metrics.reasoningTokens).toBe(3)
    expect(metrics.contextTokens).toBe(13)
  })
})
