import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { collectPlanContent, digestPlan, type PlanInputs } from '../packages/dsh-eval-harness/src/run/plan.ts'

/** Create profile/manifest/benchmark fixtures and return a plan input. */
function fixture(): { root: string; input: PlanInputs; paths: { manifest: string; profile: string; bench: string } } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-eval-plan-'))
  const profile = join(root, 'profiles', 'desktop')
  mkdirSync(profile, { recursive: true })
  writeFileSync(
    join(profile, 'package.json'),
    JSON.stringify({ name: 'desktop', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }),
  )
  writeFileSync(join(profile, 'cordis.yml'), '[]\n')
  writeFileSync(join(profile, 'cordis.patch.yml'), '- id: agent\n  name: "@deepseek-ai/dsh-agent"\n')
  const bench = join(root, 'bench')
  mkdirSync(bench, { recursive: true })
  const manifest = join(root, 'manifest.yml')
  writeFileSync(manifest, 'schema: 1\nname: fixture\n')
  const input: PlanInputs = {
    harnessProfileDir: profile,
    harnessMode: 'profile-snapshot',
    dshVersion: '0.2.1-rc.2',
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    api: 'openai-completions',
    baseURL: 'https://api.example.invalid/v1',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    manifestPath: manifest,
    benchmarkRoot: bench,
    language: 'node',
    revision: 'self-check',
    tasks: ['a', 'b'],
  }
  return { root, input, paths: { manifest, profile, bench } }
}

describe('content-addressed plan digest', () => {
  it('is stable and covers the experiment identity', () => {
    const { input } = fixture()
    expect(digestPlan(input)).toMatch(/^[0-9a-f]{64}$/)
    expect(digestPlan(input)).toBe(digestPlan({ ...input }))
    expect(digestPlan({ ...input, tasks: ['a'] })).not.toBe(digestPlan(input))
    expect(digestPlan({ ...input, model: 'other-model' })).not.toBe(digestPlan(input))
    expect(digestPlan({ ...input, baseURL: 'https://other.invalid/v1' })).not.toBe(digestPlan(input))
  })

  it('changes when the manifest bytes change', () => {
    const { input, paths } = fixture()
    const before = digestPlan(input)
    writeFileSync(paths.manifest, 'schema: 1\nname: fixture\n# changed\n')
    expect(digestPlan(input)).not.toBe(before)
  })

  it('changes when the confirmed profile changes', () => {
    const { input, paths } = fixture()
    const before = digestPlan(input)
    writeFileSync(join(paths.profile, 'cordis.patch.yml'), '- id: agent\n  disabled: true\n')
    expect(digestPlan(input)).not.toBe(before)
  })

  it('records profile files and tolerates missing lockfiles', () => {
    const { input } = fixture()
    const content = collectPlanContent(input)
    expect(content.schema).toBe(2)
    expect(content.harness.files['package.json']).toMatch(/^[0-9a-f]{64}$/)
    expect(content.harness.files['cordis.patch.yml']).toMatch(/^[0-9a-f]{64}$/)
    expect(content.harness.files['pnpm-lock.yaml']).toBeNull()
    expect(content.manifest.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(content.model.apiKeyEnv).toBe('DEEPSEEK_API_KEY')
  })
})
