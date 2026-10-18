import { describe, expect, it } from 'vitest'
import { classifyTaskStatus } from '../packages/dsh-eval-harness/src/run/status.ts'

const base = {
  started: true,
  timedOut: false,
  guard: null,
  exitCode: 0,
  traceError: undefined,
  verify: { ok: true, total: 3 },
}

describe('classifyTaskStatus', () => {
  it('marks a clean all-pass episode as passed/completed', () => {
    expect(classifyTaskStatus(base)).toEqual({ executionStatus: 'completed', taskOutcome: 'passed' })
  })

  it('marks a clean failing verifier as failed/completed', () => {
    expect(classifyTaskStatus({ ...base, verify: { ok: false, total: 3 } })).toEqual({
      executionStatus: 'completed',
      taskOutcome: 'failed',
    })
  })

  it('never reports a timeout as passed, even when the verifier passes', () => {
    const status = classifyTaskStatus({ ...base, timedOut: true })
    expect(status.executionStatus).toBe('timeout')
    expect(status.taskOutcome).toBe('ungraded')
  })

  it('never reports a guard stop as a graded outcome', () => {
    const status = classifyTaskStatus({ ...base, guard: { reason: 'max steps exceeded' } })
    expect(status.executionStatus).toBe('guard_stopped')
    expect(status.taskOutcome).toBe('ungraded')
  })

  it('never reports a crash as a graded outcome, even with a passing verifier', () => {
    const status = classifyTaskStatus({ ...base, exitCode: 7 })
    expect(status.executionStatus).toBe('agent_crashed')
    expect(status.taskOutcome).toBe('ungraded')
  })

  it('marks an unreadable trace as trace_corrupt', () => {
    const status = classifyTaskStatus({ ...base, traceError: 'trace: broken' })
    expect(status.executionStatus).toBe('trace_corrupt')
    expect(status.taskOutcome).toBe('ungraded')
  })

  it('marks a verifier infrastructure error as verifier_error', () => {
    const status = classifyTaskStatus({
      ...base,
      verify: { ok: false, total: 0, error: 'verifier: no junit report' },
    })
    expect(status.executionStatus).toBe('verifier_error')
    expect(status.taskOutcome).toBe('ungraded')
  })

  it('treats a verifier that collected no checks as ungraded', () => {
    const status = classifyTaskStatus({ ...base, verify: { ok: true, total: 0 } })
    expect(status.executionStatus).toBe('verifier_error')
    expect(status.taskOutcome).toBe('ungraded')
  })

  it('marks a task that never started as not_started/ungraded', () => {
    const status = classifyTaskStatus({ ...base, started: false })
    expect(status.executionStatus).toBe('not_started')
    expect(status.taskOutcome).toBe('ungraded')
  })
})
