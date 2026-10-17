import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadBenchmarkFromManifest } from './interpreter.ts'
import type { LoadedBenchmarkManifest } from './manifest.ts'
import { prepareWorkspace } from '../run/profile.ts'
import { runManifestVerifier } from '../run/verify.ts'

/** Red/green outcome for one task. */
export interface RedGreenTaskResult {
  readonly task: string
  /** True when the untouched/stub workspace fails as expected. */
  readonly redOk: boolean
  readonly redPassed: number
  readonly redTotal: number
  /** True when the manifest's reference solution passes the verifier. */
  readonly greenOk: boolean
  readonly greenPassed: number
  readonly greenTotal: number
}

/** Whole red/green report for one manifest. */
export interface RedGreenReport {
  readonly ok: boolean
  readonly reference: string
  readonly results: readonly RedGreenTaskResult[]
}

/**
 * Prove that a manifest really grades work: a stub workspace must fail (red)
 * and the declared reference solution must pass (green). This is the acceptance
 * test for "a new benchmark can be adapted without plugin code".
 * @param options - validated manifest, checkout root, language, tasks, timeout.
 * @returns per-task red/green results.
 */
export async function validateManifest(options: {
  readonly loaded: LoadedBenchmarkManifest
  readonly root: string
  readonly language: string
  readonly taskIds: readonly string[]
  readonly timeoutMs: number
}): Promise<RedGreenReport> {
  const manifest = options.loaded.manifest
  if (manifest.reference === undefined) {
    throw new Error('manifest validation: manifest declares no reference.file, cannot run green verification')
  }
  const reference = manifest.reference
  const benchmark = await loadBenchmarkFromManifest(
    options.loaded,
    options.root,
    options.language,
    options.taskIds,
    'manifest-validation',
  )
  const results: RedGreenTaskResult[] = []
  for (const task of benchmark.tasks) {
    const scratch = mkdtempSync(join(tmpdir(), 'dsh-eval-validate-'))
    try {
      const redWorkspace = join(scratch, 'red-workspace')
      prepareWorkspace(task, redWorkspace)
      const red = runManifestVerifier({
        manifest,
        task,
        workspaceDir: redWorkspace,
        taskDir: join(scratch, 'red'),
        timeoutMs: options.timeoutMs,
      })
      const greenWorkspace = join(scratch, 'green-workspace')
      prepareWorkspace(task, greenWorkspace)
      const targets =
        reference.target === 'solutionFiles[0]' ? task.solutionFiles.slice(0, 1) : task.solutionFiles
      for (const target of targets) {
        copyFileSync(join(task.exerciseDir, reference.file), join(greenWorkspace, target))
      }
      const green = runManifestVerifier({
        manifest,
        task,
        workspaceDir: greenWorkspace,
        taskDir: join(scratch, 'green'),
        timeoutMs: options.timeoutMs,
      })
      results.push({
        task: task.id,
        redOk: !red.ok && red.total > 0,
        redPassed: red.passed,
        redTotal: red.total,
        greenOk: green.ok && green.total > 0,
        greenPassed: green.passed,
        greenTotal: green.total,
      })
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  }
  return {
    ok: results.length > 0 && results.every((result) => result.redOk && result.greenOk),
    reference: reference.file,
    results,
  }
}
