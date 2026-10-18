import { describe, expect, it } from 'vitest'
import { parseJunit } from '../packages/dsh-eval-harness/src/run/verify.ts'

describe('parseJunit', () => {
  it('never counts a skipped test as a pass', () => {
    const xml = `<testsuite>
      <testcase classname="tests.test_x" name="test_ok"/>
      <testcase classname="tests.test_x" name="test_skip"><skipped message="why"/></testcase>
      <testcase classname="tests.test_x" name="test_fail"><failure message="boom"/></testcase>
    </testsuite>`
    const checks = parseJunit(xml)
    expect(checks.map((check) => ({ id: check.id, pass: check.pass, skipped: check.skipped }))).toEqual([
      { id: 'tests.test_x::test_ok', pass: true, skipped: false },
      { id: 'tests.test_x::test_skip', pass: false, skipped: true },
      { id: 'tests.test_x::test_fail', pass: false, skipped: false },
    ])
  })

  it('distinguishes classname from name', () => {
    const checks = parseJunit('<testsuite><testcase classname="a.b" name="c"/></testsuite>')
    expect(checks[0]?.id).toBe('a.b::c')
  })
})
