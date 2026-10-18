import { lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
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
function sourceProfile(root: string, value: string, bundleVersion?: string): string {
  const dir = join(root, 'profiles', 'fixture')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'fixture', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'] } } }),
  )
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  writeFileSync(join(dir, 'cordis.patch.yml'), "- id: custom\n  name: '@example/custom'\n  config:\n    value: " + value + '\n')
  if (bundleVersion !== undefined) {
    for (const bundle of ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless']) {
      const pkgDir = join(dir, 'node_modules', bundle)
      mkdirSync(pkgDir, { recursive: true })
      writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: bundle, version: bundleVersion }))
    }
  }
  return dir
}

describe('materializeProfile', () => {
  it('isolated-snapshot copies the profile, applies rows and records the mutation diff', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-eval-snapshot-'))
    const source = sourceProfile(root, '1')
    const materialized = materializeProfile(join(root, 'home'), 'eval', target(), {
      mode: 'isolated-snapshot',
      sourceProfileDir: source,
    })
    expect(materialized.snapshot.mode).toBe('isolated-snapshot')
    expect(materialized.snapshot.sourceProfileDir).toBe(source)
    expect(materialized.snapshot.mutationDiff.hermetic).toBe(true)
    expect(materialized.snapshot.mutationDiff.addedRows).toContain('agent-default-model')
    expect(materialized.snapshot.mutationDiff.disabledRows).toContain('credentials')
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

  it('faithful-snapshot keeps the confirmed profile unchanged and is not hermetic', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-eval-snapshot-'))
    const source = sourceProfile(root, '1')
    const faithful = materializeProfile(join(root, 'home-f'), 'eval', target(), {
      mode: 'faithful-snapshot',
      sourceProfileDir: source,
    })
    expect(faithful.snapshot.mode).toBe('faithful-snapshot')
    expect(faithful.snapshot.mutationDiff.hermetic).toBe(false)
    expect(faithful.snapshot.mutationDiff.addedRows).toEqual([])
    const patch = readFileSync(join(faithful.profileDir, 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain('@example/custom')
    expect(patch).not.toContain('agent-default-model')
    expect(patch).not.toContain('maxBytes: 0')
    const isolated = materializeProfile(join(root, 'home-i'), 'eval', target(), {
      mode: 'isolated-snapshot',
      sourceProfileDir: source,
    })
    expect(faithful.snapshot.digest).not.toBe(isolated.snapshot.digest)
  })

  it('normalizes the legacy profile-snapshot alias', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-eval-snapshot-'))
    const materialized = materializeProfile(join(root, 'home'), 'eval', target(), {
      mode: 'profile-snapshot',
      sourceProfileDir: sourceProfile(root, '1'),
    })
    expect(materialized.snapshot.mode).toBe('isolated-snapshot')
  })

  it('records resolved bundle versions and includes them in the digest', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-eval-snapshot-'))
    const first = materializeProfile(join(root, 'home-a'), 'eval', target(), {
      mode: 'isolated-snapshot',
      sourceProfileDir: sourceProfile(join(root, 'a'), '1', '0.2.1-rc.2'),
    })
    const second = materializeProfile(join(root, 'home-b'), 'eval', target(), {
      mode: 'isolated-snapshot',
      sourceProfileDir: sourceProfile(join(root, 'b'), '1', '0.2.0-rc.2'),
    })
    expect(first.snapshot.resolvedBundles['@deepseek-ai/dsh-base']).toBe('0.2.1-rc.2')
    expect(second.snapshot.resolvedBundles['@deepseek-ai/dsh-base']).toBe('0.2.0-rc.2')
    expect(first.snapshot.digest).not.toBe(second.snapshot.digest)
  })

  it('copies linked profile dependencies for self-contained snapshots', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-eval-snapshot-'))
    const source = sourceProfile(root, '1')
    const linked = join(root, 'linked-bundle')
    mkdirSync(linked, { recursive: true })
    writeFileSync(join(linked, 'package.json'), JSON.stringify({ name: 'linked-bundle', version: '1.0.0' }))
    mkdirSync(join(source, 'node_modules'), { recursive: true })
    symlinkSync(linked, join(source, 'node_modules', 'linked-bundle'), 'junction')
    const materialized = materializeProfile(join(root, 'home'), 'eval', target(), {
      mode: 'isolated-snapshot',
      sourceProfileDir: source,
      copyLinkedModules: true,
    })
    expect(materialized.snapshot.nodeModulesCopied).toBe(true)
    expect(materialized.snapshot.nodeModulesLinked).toBe(false)
    const copied = join(materialized.profileDir, 'node_modules', 'linked-bundle')
    expect(lstatSync(copied).isSymbolicLink()).toBe(false)
    expect(readFileSync(join(copied, 'package.json'), 'utf8')).toContain('linked-bundle')
  })

  it('keeps the fixed minimal control arm explicit', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-eval-snapshot-'))
    const materialized = materializeProfile(join(root, 'home'), 'eval', target(), { mode: 'minimal-control' })
    expect(materialized.snapshot.mode).toBe('minimal-control')
    expect(materialized.snapshot.sourceProfileDir).toBeNull()
    expect(materialized.snapshot.bundles).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'])
  })

  it('appends the headless app for an interactive profile and records it', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-eval-snapshot-'))
    const source = sourceProfile(root, '1')
    writeFileSync(
      join(source, 'package.json'),
      JSON.stringify({ name: 'fixture', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }),
    )
    const materialized = materializeProfile(join(root, 'home'), 'eval', target(), {
      mode: 'isolated-snapshot',
      sourceProfileDir: source,
    })
    expect(materialized.snapshot.bundles).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
    expect(materialized.snapshot.effectiveBundles).toEqual([
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-headless',
    ])
    expect(materialized.snapshot.mutationDiff.addedBundles).toEqual(['@deepseek-ai/dsh-headless'])
    expect(materialized.snapshot.mutationDiff.removedBundles).toEqual(['@deepseek-ai/dsh-web-app'])
  })

  it('faithful mode never appends the headless app', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-eval-snapshot-'))
    const source = sourceProfile(root, '1')
    writeFileSync(
      join(source, 'package.json'),
      JSON.stringify({ name: 'fixture', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }),
    )
    const materialized = materializeProfile(join(root, 'home'), 'eval', target(), {
      mode: 'faithful-snapshot',
      sourceProfileDir: source,
    })
    expect(materialized.snapshot.effectiveBundles).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
    expect(materialized.snapshot.mutationDiff.addedBundles).toEqual([])
  })
})
