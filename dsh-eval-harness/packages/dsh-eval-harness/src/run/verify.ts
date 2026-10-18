import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BenchmarkTask } from '../benchmark/interpreter.ts'
import type { BenchmarkManifest } from '../benchmark/manifest.ts'
import { renderTemplate } from '../benchmark/manifest.ts'

/** One benchmark check: one test case from the exercise's own test file. */
export interface Check {
  readonly id: string
  readonly pass: boolean
  readonly skipped: boolean
}

/** Outcome of running the benchmark's native verifier. */
export interface VerifyResult {
  /** All collected tests passed (and at least one test ran). */
  readonly ok: boolean
  readonly passed: number
  readonly total: number
  /** Test cases reported as skipped; they are never counted as passes. */
  readonly skipped?: number
  readonly checks: readonly Check[]
  /** Absolute path of the raw pytest log. */
  readonly logPath: string
  /** Verifier infrastructure error, when pytest could not grade the workspace. */
  readonly error?: string
}

/**
 * Run a manifest-declared verifier against a workspace in a throwaway copy.
 * The workspace is never mutated; test files are injected only here.
 * @param options - manifest, task, agent workspace, artifact directory, timeout.
 * @returns parsed per-test checks plus the raw verifier log.
 */
export function runManifestVerifier(options: {
  readonly manifest: BenchmarkManifest
  readonly task: BenchmarkTask
  readonly workspaceDir: string
  readonly taskDir: string
  readonly timeoutMs: number
}): VerifyResult {
  const verifyDir = join(options.taskDir, 'verify')
  const verifyWorkspace = join(verifyDir, 'workspace')
  mkdirSync(verifyWorkspace, { recursive: true })
  cpSync(options.workspaceDir, verifyWorkspace, { recursive: true })
  for (const testFile of options.task.testFiles) {
    cpSync(join(options.task.exerciseDir, testFile), join(verifyWorkspace, testFile))
  }
  const junitPath = join(verifyDir, 'junit.xml')
  const logPath = join(verifyDir, 'verifier.log')
  const verify = options.manifest.verify
  if (verify === undefined) {
    return { ok: false, passed: 0, total: 0, checks: [], logPath, error: 'verifier: manifest declares no host verify command' }
  }
  const vars = {
    language: options.task.language,
    junitPath,
    testFiles: options.task.testFiles.join(' '),
  }
  const args: string[] = []
  for (const token of verify.command) {
    if (token === '{{testFiles}}') {
      args.push(...options.task.testFiles)
      continue
    }
    args.push(renderTemplate(token, vars))
  }
  const executable = args.shift()
  if (executable === undefined) {
    return { ok: false, passed: 0, total: 0, checks: [], logPath, error: 'verifier: empty command' }
  }
  const result = spawnSync(executable, args, {
    cwd: verifyWorkspace,
    encoding: 'utf8',
    timeout: options.timeoutMs,
    windowsHide: true,
  })
  writeFileSync(logPath, (result.stdout ?? '') + (result.stderr ?? ''))
  const verifierTimedOut = result.error !== undefined && String(result.error).includes('ETIMEDOUT')
  if (verifierTimedOut) {
    return { ok: false, passed: 0, total: 0, checks: [], logPath, error: 'verifier: timed out' }
  }
  let checks: Check[] = []
  try {
    checks = parseJunit(readFileSync(junitPath, 'utf8'))
  } catch (error) {
    return {
      ok: false,
      passed: 0,
      total: 0,
      checks: [],
      logPath,
      error: 'verifier: no usable junit report (' + String(error) + ')',
    }
  }
  const passed = checks.filter((check) => check.pass).length
  const skipped = checks.filter((check) => check.skipped).length
  // pytest exits non-zero for failing tests, so the exit code is not success
  // criteria on its own; but a non-zero exit with an all-pass report is an
  // inconsistency worth refusing to grade.
  if (result.status !== 0 && passed === checks.length && checks.length > 0) {
    return {
      ok: false,
      passed,
      total: checks.length,
      skipped,
      checks: [...checks],
      logPath,
      error: 'verifier: exit code ' + String(result.status) + ' despite an all-pass report',
    }
  }
  return {
    ok: checks.length > 0 && passed === checks.length,
    passed,
    total: checks.length,
    skipped,
    checks,
    logPath,
  }
}

/**
 * Run the exercise's own tests against the agent's workspace in a throwaway copy.
 * The agent workspace is never mutated; test files are injected only here.
 * @param options - task, agent workspace, task artifact directory, timeout.
 * @returns parsed per-test checks plus the raw log path.
 */
export function runVerifier(options: {
  readonly task: BenchmarkTask
  readonly workspaceDir: string
  readonly taskDir: string
  readonly timeoutMs: number
}): VerifyResult {
  const verifyDir = join(options.taskDir, 'verify')
  const verifyWorkspace = join(verifyDir, 'workspace')
  mkdirSync(verifyWorkspace, { recursive: true })
  cpSync(options.workspaceDir, verifyWorkspace, { recursive: true })
  for (const testFile of options.task.testFiles) {
    cpSync(join(options.task.exerciseDir, testFile), join(verifyWorkspace, testFile))
  }
  const junitPath = join(verifyDir, 'junit.xml')
  const logPath = join(verifyDir, 'pytest.log')
  const result = spawnSync(
    'python',
    ['-m', 'pytest', ...options.task.testFiles, '--junitxml=' + junitPath, '-q'],
    {
      cwd: verifyWorkspace,
      encoding: 'utf8',
      timeout: options.timeoutMs,
      windowsHide: true,
    },
  )
  writeFileSync(logPath, (result.stdout ?? '') + (result.stderr ?? ''))
  let checks: Check[] = []
  try {
    checks = parseJunit(readFileSync(junitPath, 'utf8'))
  } catch (error) {
    return {
      ok: false,
      passed: 0,
      total: 0,
      checks: [],
      logPath,
      error: 'verifier: no usable junit report (' + String(error) + ')',
    }
  }
  const passed = checks.filter((check) => check.pass).length
  const skipped = checks.filter((check) => check.skipped).length
  return {
    ok: checks.length > 0 && passed === checks.length,
    passed,
    total: checks.length,
    skipped,
    checks,
    logPath,
  }
}

/**
 * Parse a pytest junit XML report into checks. Deliberately regex-based: the
 * report is a flat list of testcase elements and no XML library is needed.
 * @param xml - junit XML text.
 * @returns one check per testcase, in report order.
 */
export function parseJunit(xml: string): Check[] {
  const checks: Check[] = []
  const pattern = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/gu
  let match: RegExpExecArray | null
  while ((match = pattern.exec(xml)) !== null) {
    const attributes = match[1] ?? ''
    const body = match[3] ?? ''
    const name = attribute(attributes, 'name') ?? 'unnamed'
    const className = attribute(attributes, 'classname') ?? ''
    const failed = /<(failure|error)\b/u.test(body)
    const skipped = /<skipped\b/u.test(body)
    checks.push({
      id: className === '' ? name : className + '::' + name,
      // A skipped test proves nothing: it must never count as a pass.
      pass: !failed && !skipped,
      skipped,
    })
  }
  return checks
}

function attribute(attributes: string, name: string): string | null {
  // Anchor on a preceding space or start so `classname="…"` never satisfies a
  // `name="…"` lookup; pytest junit emits both attributes on one testcase.
  const match = new RegExp('(?:^|\\s)' + name + '="([^"]*)"', 'u').exec(attributes)
  return match?.[1] ?? null
}
