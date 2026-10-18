import { describe, expect, it } from 'vitest'
import { parsePytestText } from '../packages/dsh-eval-harness/src/run/container.ts'

describe('parsePytestText', () => {
  it('extracts per-test outcomes and never counts skipped as passed', () => {
    const log = [
      'collected 3 items',
      'PASSED ../tests/test_outputs.py::test_report_generation',
      'FAILED ../tests/test_outputs.py::test_top_urls - AssertionError',
      'SKIPPED [1] ../tests/test_outputs.py::test_optional',
      '========================= 1 failed, 1 passed, 1 skipped in 0.05s =========================',
    ].join('\n')
    const checks = parsePytestText(log)
    expect(checks).toEqual([
      { id: '../tests/test_outputs.py::test_report_generation', pass: true, skipped: false },
      { id: '../tests/test_outputs.py::test_top_urls', pass: false, skipped: false },
      { id: '../tests/test_outputs.py::test_optional', pass: false, skipped: true },
    ])
  })
})
