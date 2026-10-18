import { describe, expect, it } from 'vitest'
import { classifyToolFailure } from '../packages/dsh-eval-harness/src/run/attribution.ts'
import type { TaskSummary } from '../packages/dsh-eval-harness/src/run/runner.ts'

const task = (overrides: Partial<TaskSummary>): TaskSummary =>
  ({
    id: 'task-1',
    dir: '/tmp/task-1',
    executionStatus: 'completed',
    taskOutcome: 'passed',
    exitCode: 0,
    timedOut: false,
    durationMs: 10,
    sessionLog: '/tmp/session.jsonl',
    metrics: null,
    verify: { ok: true, passed: 1, total: 1, checks: [], logPath: '/tmp/checks.json' },
    observedModel: null,
    homeLeaks: [],
    guard: null,
    ...overrides,
  }) as TaskSummary

describe('classifyToolFailure', () => {
  it('never attributes an unrecognized failure to the harness', () => {
    const classification = classifyToolFailure('some unexpected internal error')
    expect(classification.layer).toBe('unknown')
    expect(classification.confidence).toBe('unresolved')
  })

  it('keeps ambiguous timeouts unresolved', () => {
    const classification = classifyToolFailure('operation timed out')
    expect(classification.layer).toBe('unknown')
    expect(classification.confidence).toBe('unresolved')
  })

  it('confirms provider quota errors as environment problems', () => {
    const classification = classifyToolFailure('429 RATE_LIMIT exceeded')
    expect(classification.layer).toBe('environment')
    expect(classification.confidence).toBe('confirmed')
  })

  it('derives model findings', () => {
    const classification = classifyToolFailure('401 Unauthorized: invalid api key')
    expect(classification.layer).toBe('model')
    expect(classification.confidence).toBe('confirmed')
  })
})
