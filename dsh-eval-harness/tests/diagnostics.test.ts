import { describe, expect, it } from 'vitest'
import { deriveDiagnostics } from '../packages/dsh-eval-harness/src/run/diagnostics.ts'
import type { TaskSummary } from '../packages/dsh-eval-harness/src/run/runner.ts'

const base = {
  id: 'task-1',
  dir: '/tmp/task-1',
  executionStatus: 'completed',
  taskOutcome: 'passed',
  exitCode: 0,
  timedOut: false,
  durationMs: 1,
  sessionLog: '/tmp/session.jsonl',
  metrics: null,
  verify: { ok: true, passed: 1, total: 1, checks: [], logPath: '/tmp/checks.json' },
  observedModel: { provider: 'deepseek-official', model: 'deepseek-flash' },
  observedModels: [{ provider: 'deepseek-official', model: 'deepseek-flash' }],
  homeLeaks: [],
  guard: null,
} as unknown as TaskSummary

const declared = { provider: 'deepseek-official', model: 'deepseek-flash' }

describe('deriveDiagnostics', () => {
  it('does not invent findings for a clean passing task', () => {
    expect(deriveDiagnostics([base], declared)).toEqual([])
  })

  it('reports a failed task as unknown/unresolved by default', () => {
    const diagnostics = deriveDiagnostics(
      [{ ...base, taskOutcome: 'failed', verify: { ok: false, passed: 0, total: 1, checks: [], logPath: '/tmp/checks.json' } }],
      declared,
    )
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]?.layer).toBe('unknown')
    expect(diagnostics[0]?.confidence).toBe('unresolved')
  })

  it('reports a timeout as unknown/unresolved rather than a harness defect', () => {
    const diagnostics = deriveDiagnostics([{ ...base, executionStatus: 'timeout', taskOutcome: 'ungraded' }], declared)
    expect(diagnostics[0]?.layer).toBe('unknown')
    expect(diagnostics[0]?.confidence).toBe('unresolved')
  })

  it('reports a verifier error as a possible benchmark problem', () => {
    const diagnostics = deriveDiagnostics(
      [
        {
          ...base,
          executionStatus: 'verifier_error',
          taskOutcome: 'ungraded',
          verify: { ok: false, passed: 0, total: 0, checks: [], logPath: '/tmp/checks.json', error: 'no junit' },
        },
      ],
      declared,
    )
    expect(diagnostics[0]?.layer).toBe('benchmark')
    expect(diagnostics[0]?.confidence).toBe('possible')
  })

  it('confirms a model mismatch from the trace', () => {
    const diagnostics = deriveDiagnostics(
      [
        {
          ...base,
          observedModel: { provider: 'deepseek-official', model: 'other-model' },
          observedModels: [{ provider: 'deepseek-official', model: 'other-model' }],
        },
      ],
      declared,
    )
    expect(diagnostics[0]?.kind).toBe('model-mismatch')
    expect(diagnostics[0]?.layer).toBe('model')
    expect(diagnostics[0]?.confidence).toBe('confirmed')
    expect(diagnostics[0]?.evidence[0]?.rule).toBe('model-mismatch')
  })

  it('detects a mismatch that only appears in a later request', () => {
    const diagnostics = deriveDiagnostics(
      [
        {
          ...base,
          observedModel: { provider: 'deepseek-official', model: 'deepseek-flash' },
          observedModels: [
            { provider: 'deepseek-official', model: 'deepseek-flash' },
            { provider: 'siliconflow', model: 'Qwen/Qwen3-8B' },
          ],
        },
      ],
      declared,
    )
    expect(diagnostics[0]?.kind).toBe('model-mismatch')
    expect(diagnostics[0]?.evidence).toHaveLength(1)
  })

  it('reports a home-directory leak as a probable harness problem', () => {
    const diagnostics = deriveDiagnostics([{ ...base, homeLeaks: [{ seq: 7, type: 'tool/result' }] }], declared)
    expect(diagnostics[0]?.kind).toBe('isolation-home-leak')
    expect(diagnostics[0]?.layer).toBe('harness')
    expect(diagnostics[0]?.confidence).toBe('probable')
    expect(diagnostics[0]?.evidence[0]?.eventSeq).toBe(7)
  })
})
