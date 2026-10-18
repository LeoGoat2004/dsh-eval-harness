import { describe, expect, it } from 'vitest'
import { isTransientVerifierFailure } from '../packages/dsh-eval-harness/src/run/container.ts'

describe('isTransientVerifierFailure', () => {
  it('recognises bootstrapping and network failures', () => {
    expect(isTransientVerifierFailure('E: Failed to fetch ... 502 Bad Gateway')).toBe(true)
    expect(isTransientVerifierFailure('curl: (7) Failed to connect')).toBe(true)
    expect(isTransientVerifierFailure('Temporary failure in name resolution')).toBe(true)
    expect(isTransientVerifierFailure('npm error ETIMEDOUT')).toBe(true)
  })

  it('does not treat a real grading failure as transient', () => {
    expect(isTransientVerifierFailure('FAILED test_outputs.py - AssertionError: expected 1')).toBe(false)
    expect(isTransientVerifierFailure('E   assert 0 > 1')).toBe(false)
  })
})
