import { describe, expect, it } from 'vitest'
import { planDigest } from '../packages/dsh-eval-harness/src/run/plan.ts'

const base = {
  harnessProfileDir: '/profiles/desktop',
  harnessMode: 'profile-snapshot' as const,
  dshVersion: '0.2.1-rc.2',
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  manifestPath: '/bench/manifest.yml',
  language: 'node',
  revision: 'self-check',
  tasks: ['a', 'b'],
}

describe('planDigest', () => {
  it('is stable for the same plan', () => {
    expect(planDigest(base)).toBe(planDigest({ ...base }))
    expect(planDigest(base)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('changes when the harness mode changes', () => {
    expect(planDigest({ ...base, harnessMode: 'minimal-control' })).not.toBe(planDigest(base))
  })

  it('changes when the task list changes', () => {
    expect(planDigest({ ...base, tasks: ['a'] })).not.toBe(planDigest(base))
    expect(planDigest({ ...base, tasks: ['b', 'a'] })).not.toBe(planDigest(base))
  })

  it('changes when the model changes', () => {
    expect(planDigest({ ...base, model: 'other' })).not.toBe(planDigest(base))
  })
})
