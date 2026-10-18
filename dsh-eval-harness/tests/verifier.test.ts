import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { BenchmarkTask } from '../packages/dsh-eval-harness/src/benchmark/interpreter.ts'
import type { BenchmarkManifest } from '../packages/dsh-eval-harness/src/benchmark/manifest.ts'
import { runManifestVerifier } from '../packages/dsh-eval-harness/src/run/verify.ts'

/**
 * Run one verifier against a throwaway workspace.
 * @param body - Node script body; receives the junit path as argv[2].
 * @param timeoutMs - verifier timeout.
 * @returns the verifier result.
 */
function verifyWith(body: string, timeoutMs = 10_000) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-eval-verify-'))
  const workspaceDir = join(root, 'workspace')
  mkdirSync(workspaceDir, { recursive: true })
  const script = join(root, 'verify.mjs')
  writeFileSync(script, "import { writeFileSync } from 'node:fs'\nconst junitPath = process.argv[2]\n" + body + '\n')
  const manifest = {
    verify: { command: [process.execPath, script, '{{junitPath}}'], result: 'junitxml' },
  } as unknown as BenchmarkManifest
  const task = {
    id: 'unit-task',
    language: 'unit',
    prompt: '',
    solutionFiles: [],
    testFiles: [],
    exclude: [],
    exerciseDir: root,
  } as unknown as BenchmarkTask
  return runManifestVerifier({ manifest, task, workspaceDir, taskDir: root, timeoutMs })
}

const junit = (body: string, exit = 0) =>
  `writeFileSync(junitPath, ${JSON.stringify('<testsuite>' + body + '</testsuite>')}); process.exit(${String(exit)})`

describe('runManifestVerifier', () => {
  it('grades an all-pass junit report as ok', () => {
    const result = verifyWith(junit('<testcase classname="t" name="a"/>'))
    expect(result.ok).toBe(true)
    expect(result.passed).toBe(1)
    expect(result.skipped ?? 0).toBe(0)
  })

  it('does not grade a skipped-only report as ok', () => {
    const result = verifyWith(junit('<testcase classname="t" name="a"><skipped/></testcase>'))
    expect(result.ok).toBe(false)
    expect(result.skipped).toBe(1)
  })

  it('refuses an all-pass report produced by a non-zero exit', () => {
    const result = verifyWith(junit('<testcase classname="t" name="a"/>', 3))
    expect(result.ok).toBe(false)
    expect(result.error ?? '').toContain('exit code 3')
  })

  it('reports a timed-out verifier as an infrastructure error', () => {
    const result = verifyWith('setTimeout(() => {}, 30_000)', 500)
    expect(result.ok).toBe(false)
    expect(result.error ?? '').toContain('timed out')
  })

  it('reports a missing junit report as an infrastructure error', () => {
    const result = verifyWith('process.exit(0)')
    expect(result.ok).toBe(false)
    expect(result.error ?? '').toContain('junit')
  })
})
