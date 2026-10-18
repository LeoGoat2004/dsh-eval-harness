import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { BenchmarkTask } from '../benchmark/interpreter.ts'
import type { ModelTarget } from '../model/target.ts'
import { createLoopGuard, type LoopGuardLimits, type LoopGuardTrip } from './guard.ts'

/** How the harness under test is chosen. */
export type HarnessMode = 'profile-snapshot' | 'minimal-control'

/** Frozen description of the harness under test, recorded with every run. */
export interface HarnessSnapshot {
  readonly mode: HarnessMode
  /** Source profile copied in `profile-snapshot` mode; null for `minimal-control`. */
  readonly sourceProfileDir: string | null
  readonly bundles: readonly string[]
  /** Whether the snapshot reuses the source profile's installed modules. */
  readonly nodeModulesLinked: boolean
  /** Rows the snapshot refuses to copy (reserved for future bundle filtering). */
  readonly excludedRows: readonly string[]
  /** SHA-256 over the frozen profile files and bundles. */
  readonly digest: string
  readonly files: Readonly<Record<string, string>>
}

/** Absolute paths of the private Harness home materialized for one run. */
export interface EvalProfilePaths {
  readonly dshHome: string
  readonly profileDir: string
  readonly profileName: string
  readonly snapshot: HarnessSnapshot
}

/** Result of one spawned `dsh` episode. */
export interface EpisodeProcessResult {
  readonly exitCode: number | null
  readonly timedOut: boolean
  readonly durationMs: number
  readonly stdout: string
  readonly stderr: string
  /** Set when the loop guard stopped the episode before the timeout. */
  readonly guard: LoopGuardTrip | null
}

const EVAL_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless']

/** Rows appended to every eval profile: credential isolation, no skills, fixed model. */
function evalRows(target: ModelTarget): string[] {
  const rows: string[] = [
    "# Eval profile: credentials come from the child environment, not the user's home.",
    '- id: credentials',
    "  name: '@deepseek-ai/dsh-credentials-local'",
    '  disabled: true',
    '- id: authorization',
    "  name: '@deepseek-ai/dsh-authorization'",
    '  disabled: true',
    '- id: deepseek-account',
    "  name: '@deepseek-ai/dsh-deepseek-account-platform'",
    '  disabled: true',
    // Hermetic prompt: no user/project skills and no user/project instruction
    // files may enter an evaluated episode. Only the run workspace is visible.
    // tool-skill is disabled too: some plugins (e.g. the Windows ACL backend)
    // register bundled skills directly in the registry, bypassing the filesystem
    // provider, so removing the loader tool is the reliable boundary.
    '- id: tool-skill',
    "  name: '@deepseek-ai/dsh-tool-skill'",
    '  disabled: true',
    '- id: skill-badge',
    "  name: '@deepseek-ai/dsh-skill-badge'",
    '  disabled: true',
    '- id: skill-filesystem',
    "  name: '@deepseek-ai/dsh-skill-filesystem'",
    '  disabled: true',
    '- id: agent-instructions',
    "  name: '@deepseek-ai/dsh-agent-instructions'",
    '  config:',
    '    maxBytes: 0',
  ]
  if (target.provider === 'deepseek-official') {
    rows.push('- id: llm-deepseek', "  name: '@deepseek-ai/dsh-llm-deepseek-api-key'", '  config:')
    rows.push('    apiKeyEnv: ' + yaml(target.apiKeyEnv))
    if (target.baseURL !== undefined) rows.push('    baseURL: ' + yaml(target.baseURL))
  } else {
    rows.push(
      '- id: llm-pi-ai',
      "  name: '@deepseek-ai/dsh-llm-pi-ai'",
      '  config:',
      '    providers:',
      '      ' + target.provider + ':',
      '        apiKeyEnv: ' + yaml(target.apiKeyEnv),
    )
    if (target.api !== undefined) rows.push('        api: ' + yaml(target.api))
    if (target.baseURL !== undefined) rows.push('        baseURL: ' + yaml(target.baseURL))
    rows.push('        models:', '          - id: ' + yaml(target.model))
  }
  rows.push(
    '- id: agent-default-model',
    "  name: '@deepseek-ai/dsh-agent-default-model'",
    '  config:',
    '    provider: ' + yaml(target.provider),
    '    model: ' + yaml(target.model),
    '',
  )
  return rows
}

/**
 * Materialize the private eval profile used to run evaluated episodes.
 *
 * `minimal-control` uses the fixed base + headless layers as a control arm.
 * `profile-snapshot` copies the user-confirmed profile (bundles, patch rows,
 * dependencies) into the private home and appends trace/isolation/model rows,
 * so the evaluated harness is the one the user selected.
 * @param dshHome - private Harness home for this run.
 * @param profileName - profile name to create inside that home.
 * @param target - resolved model target (provider, model, endpoint, credential env).
 * @param options - harness mode and, for snapshots, the source profile directory.
 * @returns absolute paths of the created profile plus its frozen snapshot.
 */
export function materializeProfile(
  dshHome: string,
  profileName: string,
  target: ModelTarget,
  options: { readonly mode: HarnessMode; readonly sourceProfileDir?: string },
): EvalProfilePaths {
  const profileDir = join(dshHome, 'profiles', profileName)
  mkdirSync(profileDir, { recursive: true })
  if (options.mode === 'profile-snapshot') {
    return materializeSnapshot(profileDir, profileName, dshHome, target, options.sourceProfileDir)
  }
  writeJson(join(profileDir, 'package.json'), {
    name: 'dsh-profile-' + profileName,
    private: true,
    dsh: { profile: { bundles: EVAL_BUNDLES } },
  })
  writeFileSync(join(profileDir, 'cordis.yml'), '[]\n')
  writeFileSync(join(profileDir, 'cordis.patch.yml'), evalRows(target).join('\n'))
  const snapshot: HarnessSnapshot = {
    mode: 'minimal-control',
    sourceProfileDir: null,
    bundles: [...EVAL_BUNDLES],
    nodeModulesLinked: false,
    excludedRows: [],
    digest: digestOf({ mode: 'minimal-control', bundles: EVAL_BUNDLES, rows: evalRows(target) }),
    files: {},
  }
  return { dshHome, profileDir, profileName, snapshot }
}

/** Copy a user profile into the private home and append isolation/model rows. */
function materializeSnapshot(
  profileDir: string,
  profileName: string,
  dshHome: string,
  target: ModelTarget,
  sourceProfileDir: string | undefined,
): EvalProfilePaths {
  if (sourceProfileDir === undefined || !existsSync(sourceProfileDir)) {
    throw new Error('profile-snapshot mode requires an existing source profile directory')
  }
  const sourcePackagePath = join(sourceProfileDir, 'package.json')
  if (!existsSync(sourcePackagePath)) {
    throw new Error('profile-snapshot: source profile has no package.json: ' + sourceProfileDir)
  }
  const sourcePackage = JSON.parse(readFileSync(sourcePackagePath, 'utf8')) as Record<string, unknown>
  const bundles = readBundles(sourcePackage)
  if (bundles.length === 0) {
    throw new Error('profile-snapshot: source profile declares no dsh.profile.bundles')
  }
  const sourceCordis = readIfExists(join(sourceProfileDir, 'cordis.yml')) ?? '[]\n'
  const sourcePatch = readIfExists(join(sourceProfileDir, 'cordis.patch.yml')) ?? ''
  const appendedRows = evalRows(target).join('\n')
  const patchText = sourcePatch.trim() === '' ? appendedRows : sourcePatch.trimEnd() + '\n' + appendedRows
  parseYaml(patchText) // fail fast when the source patch is not valid YAML
  writeJson(join(profileDir, 'package.json'), {
    ...sourcePackage,
    name: 'dsh-profile-' + profileName,
    private: true,
    dsh: { profile: { ...(isObject(sourcePackage.dsh) ? sourcePackage.dsh : {}), bundles } },
  })
  writeFileSync(join(profileDir, 'cordis.yml'), sourceCordis)
  writeFileSync(join(profileDir, 'cordis.patch.yml'), patchText)
  let nodeModulesLinked = false
  const sourceModules = join(sourceProfileDir, 'node_modules')
  const targetModules = join(profileDir, 'node_modules')
  if (existsSync(sourceModules) && !existsSync(targetModules)) {
    try {
      symlinkSync(sourceModules, targetModules, 'junction')
      nodeModulesLinked = true
    } catch {
      nodeModulesLinked = false
    }
  }
  const snapshot: HarnessSnapshot = {
    mode: 'profile-snapshot',
    sourceProfileDir,
    bundles,
    nodeModulesLinked,
    excludedRows: [],
    digest: digestOf({ mode: 'profile-snapshot', bundles, cordis: sourceCordis, patch: patchText }),
    files: {
      'package.json': sha256(readFileSync(sourcePackagePath, 'utf8')),
      'cordis.yml': sha256(sourceCordis),
      'cordis.patch.yml': sha256(sourcePatch),
    },
  }
  return { dshHome, profileDir, profileName, snapshot }
}

/** Read `dsh.profile.bundles` from a profile package.json. */
function readBundles(pkg: Record<string, unknown>): string[] {
  const dsh = pkg.dsh
  if (!isObject(dsh)) return []
  const profile = dsh.profile
  if (!isObject(profile)) return []
  const bundles = profile.bundles
  if (!Array.isArray(bundles)) return []
  return bundles.filter((item): item is string => typeof item === 'string' && item !== '')
}

function readIfExists(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function digestOf(value: unknown): string {
  return sha256(JSON.stringify(value))
}

/** Quote one scalar as a YAML-safe double-quoted string. */
function yaml(value: string): string {
  return JSON.stringify(value)
}

/**
 * Write the per-task `--patch` overlay that redirects session persistence to the
 * task trace directory as uncompressed JSONL (externally readable).
 * @param taskDir - absolute task artifact directory.
 * @param traceDir - absolute trace directory for this task.
 * @returns absolute overlay path.
 */
export function writeTaskOverlay(taskDir: string, traceDir: string): string {
  mkdirSync(traceDir, { recursive: true })
  const overlay = join(taskDir, 'overlay.yml')
  writeFileSync(
    overlay,
    [
      '- id: session-persistence-jsonl',
      "  name: '@deepseek-ai/dsh-session-persistence-jsonl'",
      '  config:',
      "    root: '" + toPosix(traceDir) + "'",
      '    compression: none',
      '',
    ].join('\n'),
  )
  return overlay
}

/**
 * Seed the agent workspace: copy the exercise tree but never answers or tests.
 * @param task - task being prepared.
 * @param workspaceDir - absolute destination workspace directory.
 */
export function prepareWorkspace(task: BenchmarkTask, workspaceDir: string): void {
  mkdirSync(workspaceDir, { recursive: true })
  const excludes = new Set(task.exclude)
  copyTree(task.exerciseDir, workspaceDir, excludes, '')
}

/**
 * Spawn one headless `dsh` episode and enforce a hard timeout plus the loop
 * guard. The guard watches the durable trace while the child runs, so a model
 * that repeats one tool call forever is stopped early instead of burning the
 * whole timeout budget.
 * @param options - command, workspace, environment, timeout, trace dir, limits, and log sinks.
 * @returns the process outcome; `timedOut` and `guard` are orthogonal to `exitCode`.
 */
export async function runEpisode(options: {
  readonly dshBin: string
  readonly dshHome: string
  readonly profileName: string
  readonly overlayPath: string
  readonly workspaceDir: string
  readonly traceDir: string
  readonly prompt: string
  readonly env: NodeJS.ProcessEnv
  readonly timeoutMs: number
  readonly limits: LoopGuardLimits
}): Promise<EpisodeProcessResult> {
  const started = Date.now()
  const child = spawn(
    process.execPath,
    [
      options.dshBin,
      '--profile',
      options.profileName,
      '--patch',
      options.overlayPath,
      options.prompt,
    ],
    {
      cwd: options.workspaceDir,
      env: { ...options.env, DSH_HOME: options.dshHome },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  )
  const out: string[] = []
  const err: string[] = []
  child.stdout?.on('data', (chunk: Buffer) => out.push(chunk.toString('utf8')))
  child.stderr?.on('data', (chunk: Buffer) => err.push(chunk.toString('utf8')))
  return new Promise<EpisodeProcessResult>((resolve, reject) => {
    let settled = false
    const guard = createLoopGuard(options.limits)
    let processedLines = 0
    const finish = (result: EpisodeProcessResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearInterval(poller)
      resolve(result)
    }
    const timer = setTimeout(() => {
      killTree(child)
      finish({
        exitCode: null,
        timedOut: true,
        durationMs: Date.now() - started,
        stdout: out.join(''),
        stderr: err.join(''),
        guard: null,
      })
    }, options.timeoutMs)
    const poller = setInterval(() => {
      if (settled) return
      const log = findSessionLog(options.traceDir)
      if (log === null) return
      let text: string
      try {
        text = readFileSync(log, 'utf8')
      } catch {
        return
      }
      const lines = text.split(/\r?\n/u)
      while (processedLines < lines.length) {
        const line = lines[processedLines]
        if (line === undefined) return
        if (line.trim() === '') {
          processedLines += 1
          continue
        }
        let parsed: unknown
        try {
          parsed = JSON.parse(line)
        } catch {
          return // incomplete trailing row; retry on the next poll
        }
        processedLines += 1
        const trip = guard.observe(
          parsed as {
            readonly type?: string
            readonly step?: number
            readonly data?: { readonly name?: string; readonly arguments?: string }
          },
        )
        if (trip !== null) {
          killTree(child)
          finish({
            exitCode: null,
            timedOut: false,
            durationMs: Date.now() - started,
            stdout: out.join(''),
            stderr: err.join(''),
            guard: trip,
          })
          return
        }
      }
    }, 2000)
    child.once('error', (error) => {
      settled = true
      clearTimeout(timer)
      clearInterval(poller)
      reject(error)
    })
    child.once('close', (code) => {
      finish({
        exitCode: code,
        timedOut: false,
        durationMs: Date.now() - started,
        stdout: out.join(''),
        stderr: err.join(''),
        guard: null,
      })
    })
  })
}

/**
 * Kill a child and every descendant. Direct-child kill leaks grandchildren that
 * keep pipes open on Windows, so use `taskkill /T /F` there.
 * @param child - the spawned episode process.
 */
export function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    return
  }
  child.kill('SIGKILL')
}

/**
 * Find the newest session log under a trace directory.
 * @param traceDir - trace root for the task.
 * @returns absolute path of the session JSONL, or null when none was written.
 */
export function findSessionLog(traceDir: string): string | null {
  const found: { path: string; mtime: number }[] = []
  const walk = (dir: string): void => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile() && /^session(\.v\d+)?\.jsonl$/u.test(entry.name)) {
        found.push({ path, mtime: statSync(path).mtimeMs })
      }
    }
  }
  walk(traceDir)
  found.sort((a, b) => b.mtime - a.mtime)
  return found[0]?.path ?? null
}

/**
 * Copy a tree while skipping excluded relative paths.
 * @param source - absolute source root.
 * @param target - absolute destination root.
 * @param excludes - relative paths to skip (files or directories).
 * @param prefix - relative path prefix used during recursion.
 */
function copyTree(source: string, target: string, excludes: ReadonlySet<string>, prefix: string): void {
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : prefix + '/' + entry.name
    if (excludes.has(relative) || excludes.has(entry.name) && prefix === '') continue
    const from = join(source, entry.name)
    const to = join(target, entry.name)
    if (entry.isDirectory()) {
      mkdirSync(to, { recursive: true })
      copyTree(from, to, excludes, relative)
    } else if (entry.isFile()) {
      cpSync(from, to)
    }
  }
}

/** Write one JSON file with a trailing newline and stable formatting. */
export function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n')
}

/** Normalize a Windows path for a YAML scalar. */
function toPosix(path: string): string {
  return path.replaceAll('\\', '/')
}

/** Whether a directory exists. */
export function directoryExists(path: string): boolean {
  return existsSync(path)
}
