import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { BenchmarkTask } from '../benchmark/interpreter.ts'
import type { ModelTarget } from '../model/target.ts'
import { createLoopGuard, type LoopGuardLimits, type LoopGuardTrip } from './guard.ts'

/** Absolute paths of the private Harness home materialized for one run. */
export interface EvalProfilePaths {
  readonly dshHome: string
  readonly profileDir: string
  readonly profileName: string
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

/**
 * Materialize the private eval profile used to run evaluated episodes.
 *
 * The profile is a normal DSH profile. It disables the credentials and account
 * rows so the provider reads its credential from the child environment, pins
 * the confirmed model target through `agent-default-model`, and keeps sessions
 * in this run's private home.
 * @param dshHome - private Harness home for this run.
 * @param profileName - profile name to create inside that home.
 * @param target - resolved model target (provider, model, endpoint, credential env).
 * @returns absolute paths of the created profile.
 */
export function materializeProfile(
  dshHome: string,
  profileName: string,
  target: ModelTarget,
): EvalProfilePaths {
  const profileDir = join(dshHome, 'profiles', profileName)
  mkdirSync(profileDir, { recursive: true })
  writeJson(join(profileDir, 'package.json'), {
    name: 'dsh-profile-' + profileName,
    private: true,
    dsh: { profile: { bundles: EVAL_BUNDLES } },
  })
  writeFileSync(join(profileDir, 'cordis.yml'), '[]\n')
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
  writeFileSync(join(profileDir, 'cordis.patch.yml'), rows.join('\n'))
  return { dshHome, profileDir, profileName }
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
 * Build the prompt handed to the agent.
 * @param task - the task to describe.
 * @returns one self-contained prompt.
 */
export function buildPrompt(task: BenchmarkTask): string {
  return [
    'You are working in a Python repository that contains one programming exercise.',
    '',
    task.prompt,
    '',
    '## Your task',
    '',
    'Implement the exercise in: ' + task.solutionFiles.join(', ') + '.',
    'Work only inside the current directory. The grading tests are not present in this',
    'workspace and must not be recreated; implement the public interface the exercise',
    'describes. You may run `python -m pytest` on tests you write yourself.',
  ].join('\n')
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
