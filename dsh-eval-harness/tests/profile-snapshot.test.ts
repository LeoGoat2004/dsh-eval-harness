import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { materializeProfile } from '../packages/dsh-eval-harness/src/run/profile.ts'
import type { ModelTarget } from '../packages/dsh-eval-harness/src/model/target.ts'

const target = (): ModelTarget => ({
  harnessProfile: 'fixture',
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  api: undefined,
  baseURL: undefined,
  apiKeyEnv: 'DEEPSEEK_API_KEY',
  listed: true,
})

/** Create a minimal source profile with one extra patch row. */
function sourceProfile(root: string, value: string): string {
  const dir = join(root, 'profiles', 'fixture')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'fixture', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'] } } }),
  )
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  writeFileSync(join(dir, 'cordis.patch.yml'), "- id: custom\n  name: '@example/custom'\n  config:\n    value: " + value + '\n')
  return dir
}

describe('materializeProfile', () => {
  it('copies the confirmed profile and appends isolation/model rows', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-eval-snapshot-'))
    const source = sourceProfile(root, '1')
    const materialized = materializeProfile(join(root, 'home'), 'eval', target(), {
      mode: 'profile-snapshot',
      sourceProfileDir: source,
    })
    expect(materialized.snapshot.mode).toBe('profile-snapshot')
    expect(materialized.snapshot.sourceProfileDir).toBe(source)
    const profilePackage = JSON.parse(readFileSync(join(materialized.profileDir, 'package.json'), 'utf8')) as {
      dsh: { profile: { bundles: string[] } }
    }
    expect(profilePackage.dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'])
    const patch = readFileSync(join(materialized.profileDir, 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain('@example/custom')
    expect(patch).toContain('agent-default-model')
    expect(patch).toContain('maxBytes: 0')
    expect(materialized.snapshot.digest).toMatch(/^[0-9a-f]{64}$/)
  })

  it('changes the snapshot digest when the source profile changes', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-eval-snapshot-'))
    const first = materializeProfile(join(root, 'home-a'), 'eval', target(), {
      mode: 'profile-snapshot',
      sourceProfileDir: sourceProfile(join(root, 'a'), '1'),
    })
    const second = materializeProfile(join(root, 'home-b'), 'eval', target(), {
      mode: 'profile-snapshot',
      sourceProfileDir: sourceProfile(join(root, 'b'), '2'),
    })
    expect(first.snapshot.digest).not.toBe(second.snapshot.digest)
  })

  it('keeps the fixed minimal control arm explicit', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-eval-snapshot-'))
    const materialized = materializeProfile(join(root, 'home'), 'eval', target(), { mode: 'minimal-control' })
    expect(materialized.snapshot.mode).toBe('minimal-control')
    expect(materialized.snapshot.sourceProfileDir).toBeNull()
    expect(materialized.snapshot.bundles).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'])
  })
})
