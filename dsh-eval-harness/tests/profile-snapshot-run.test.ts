import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runEvaluation } from '../packages/dsh-eval-harness/src/run/runner.ts'

/** Stub launcher proving which materialized profile the episode was started from. */
const STUB = `
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const profileIndex = process.argv.indexOf('--profile')
const profileName = process.argv[profileIndex + 1]
const dshHome = process.env.DSH_HOME
const patch = readFileSync(join(dshHome, 'profiles', profileName, 'cordis.patch.yml'), 'utf8')
writeFileSync(process.env.CAPTURE_PATH, JSON.stringify({ profileName, patch, prompt: process.argv.at(-1) }))
process.exit(0)
`

/** Minimal benchmark with a node requirement and a non-grading verifier. */
function benchmarkFixture(root: string): string {
  const bench = join(root, 'bench')
  const taskDir = join(bench, 'node', 't1')
  mkdirSync(taskDir, { recursive: true })
  writeFileSync(join(taskDir, 'prompt.md'), 'do nothing')
  const manifest = join(root, 'manifest.yml')
  writeFileSync(
    manifest,
    [
      'schema: 1',
      'name: snapshot-fixture',
      'tasks:',
      '  discovery: directory',
      '  root: "{{language}}"',
      '  exclude: []',
      'prompt:',
      '  files:',
      '    - path: prompt.md',
      '  template: "{{prompt}}"',
      'verify:',
      '  command: [node, -e, "process.exit(0)"]',
      '  result: junitxml',
      'environment:',
      '  requirements:',
      '    - id: node',
      '      command: node',
      '      args: [--version]',
      '      reason: fixture',
      '',
    ].join('\n'),
  )
  return manifest
}

/** Synthetic confirmed profile with one distinguishing patch row. */
function profileFixture(root: string, marker: string): string {
  const dir = join(root, 'profiles', marker)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: marker, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'] } } }),
  )
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  writeFileSync(join(dir, 'cordis.patch.yml'), "- id: marker\n  name: '@example/" + marker + "'\n")
  return dir
}

async function runOnce(root: string, profileDir: string, outputDir: string): Promise<{ runDir: string; digest: string }> {
  const capture = join(root, 'capture-' + Date.now().toString(36) + '.json')
  const stub = join(root, 'stub.mjs')
  writeFileSync(stub, STUB)
  const summary = await runEvaluation({
    benchmarkRoot: join(root, 'bench'),
    benchmarkRevision: 'self-check',
    language: 'node',
    taskIds: ['t1'],
    dshBin: stub,
    dshVersion: 'self-check',
    outputDir,
    profileName: 'eval-test',
    timeoutMs: 30_000,
    permissionMode: 'danger-full-access',
    harnessMode: 'profile-snapshot',
    harnessProfileDir: profileDir,
    env: { ...process.env, CAPTURE_PATH: capture, DEEPSEEK_API_KEY: 'dummy' },
    model: {
      harnessProfile: 'fixture',
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      api: undefined,
      baseURL: undefined,
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      listed: true,
    },
    manifestPath: join(root, 'manifest.yml'),
    guard: { maxSteps: 10, maxIdenticalToolCalls: 3 },
  })
  const run = JSON.parse(readFileSync(join(summary.runDir, 'run.json'), 'utf8')) as {
    harness: { digest: string }
  }
  return { runDir: summary.runDir, digest: run.harness.digest }
}

describe('profile-snapshot end to end (stub launcher)', () => {
  it('runs the materialized confirmed profile and changes identity with the profile', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-eval-snapshot-run-'))
    benchmarkFixture(root)
    const profileA = profileFixture(root, 'profile-a')
    const profileB = profileFixture(root, 'profile-b')
    const first = await runOnce(root, profileA, join(root, 'runs-a'))
    const second = await runOnce(root, profileB, join(root, 'runs-b'))
    expect(first.digest).not.toBe(second.digest)
    // The stub reads the exact profile it was launched with; each capture proves
    // that the source profile's row reached the evaluated profile.
    const captures = [join(root, 'runs'), first.runDir]
    const patchA = readFileSync(join(first.runDir, 'dsh-home', 'profiles', 'eval-test', 'cordis.patch.yml'), 'utf8')
    const patchB = readFileSync(join(second.runDir, 'dsh-home', 'profiles', 'eval-test', 'cordis.patch.yml'), 'utf8')
    expect(patchA).toContain('@example/profile-a')
    expect(patchB).toContain('@example/profile-b')
    expect(patchA).toContain('maxBytes: 0')
    expect(patchB).toContain('maxBytes: 0')
    expect(captures.length).toBe(2)
  })
})
