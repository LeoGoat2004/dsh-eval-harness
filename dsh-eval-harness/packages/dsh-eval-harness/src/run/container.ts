import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BenchmarkTask } from '../benchmark/interpreter.ts'
import type { BenchmarkManifest } from '../benchmark/manifest.ts'
import { renderTemplate } from '../benchmark/manifest.ts'
import { parseJunit, type VerifyResult } from './verify.ts'

/** One environment observation for container execution. */
export interface ContainerCheck {
  readonly ok: boolean
  readonly detail: string
}

/** Outcome of one container episode (agent + grading inside the same container). */
export interface ContainerEpisodeResult {
  readonly exitCode: number | null
  readonly timedOut: boolean
  readonly durationMs: number
  readonly log: string
  readonly agentExit: number | null
  readonly verifyExit: number | null
  readonly verify: VerifyResult
}

/** Standard container paths the executor always provides. */
export const CONTAINER_PATHS = {
  runScript: '/dsh-run.sh',
  promptFile: '/dsh-prompt.txt',
  verifyDir: '/dsh-verify',
  junitPath: '/dsh-verify/junit.xml',
} as const

/**
 * Check that a container runtime is reachable. The plugin never installs it.
 * @returns check with a readable detail.
 */
export function dockerRuntimeCheck(): ContainerCheck {
  const result = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
    encoding: 'utf8',
    timeout: 20_000,
    windowsHide: true,
  })
  const version = (result.stdout ?? '').trim()
  if (result.status === 0 && version !== '') return { ok: true, detail: 'docker ' + version }
  return {
    ok: false,
    detail: 'container runtime unavailable: ' + (lastLine(result.stderr) || 'docker version failed'),
  }
}

/**
 * Check that an image exists locally. The plugin never pulls or builds: a
 * missing image is an environment problem and is reported as such.
 * @param image - image reference.
 * @returns check with a readable detail.
 */
export function containerImageCheck(image: string): ContainerCheck {
  const result = spawnSync('docker', ['image', 'inspect', '--format', '{{.Id}}', image], {
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  })
  if (result.status === 0) return { ok: true, detail: 'image present: ' + image }
  return {
    ok: false,
    detail: 'image missing: ' + image + ' — the environment must provide it; the plugin never builds images',
  }
}

/**
 * Render one container value: host-environment placeholders first, then task
 * variables. Unknown placeholders stay untouched so misconfiguration is visible.
 * @param value - template string.
 * @param vars - per-task variables.
 * @returns rendered string.
 */
export function renderContainerValue(value: string, vars: Readonly<Record<string, string>>): string {
  const withEnv = value.replace(/\{\{\s*env:([A-Za-z0-9_]+)\s*\}\}/gu, (_match, name: string) => process.env[name] ?? '')
  return renderTemplate(withEnv, vars)
}

/** Variables available to every container template. */
export function containerVars(
  manifest: BenchmarkManifest,
  task: BenchmarkTask,
  paths: { taskDir: string; traceDir: string },
): Record<string, string> {
  const container = manifest.execution?.container
  return {
    name: manifest.name,
    language: task.language,
    taskId: task.id,
    taskDir: paths.taskDir,
    workspace: container?.workspace ?? '/app',
    tracePath: container?.tracePath ?? '/trace',
    promptFile: CONTAINER_PATHS.promptFile,
    verifyDir: CONTAINER_PATHS.verifyDir,
    junitPath: CONTAINER_PATHS.junitPath,
    hostTraceDir: paths.traceDir,
  }
}

/**
 * Run one episode inside a container: agent command first, grading command
 * second, both in the same container so filesystem changes persist.
 * @param options - manifest, task, host directories, timeout.
 * @returns process outcome, marker exits and parsed verifier checks.
 */
export function runContainerEpisode(options: {
  readonly manifest: BenchmarkManifest
  readonly task: BenchmarkTask
  readonly taskDir: string
  readonly workspaceDir: string
  readonly traceDir: string
  readonly verifyDir: string
  readonly promptFile: string
  readonly timeoutMs: number
  readonly logPath: string
}): ContainerEpisodeResult {
  const container = options.manifest.execution?.container
  if (container === undefined) throw new Error('container execution: manifest has no execution.container block')
  mkdirSync(options.workspaceDir, { recursive: true })
  mkdirSync(options.traceDir, { recursive: true })
  mkdirSync(options.verifyDir, { recursive: true })
  const vars = containerVars(options.manifest, options.task, {
    taskDir: options.taskDir,
    traceDir: options.traceDir,
  })
  const tracePath = container.tracePath ?? '/trace'
  const renderCommand = (command: readonly string[]): string =>
    command.map((token) => shellQuote(renderContainerValue(token, vars))).join(' ')
  const runScript = join(options.verifyDir, 'run.sh')
  writeFileSync(
    runScript,
    [
      '#!/bin/bash',
      'set +e',
      renderCommand(container.agentCommand),
      'echo AGENT_EXIT=$?',
      renderCommand(container.verifyCommand),
      'echo VERIFY_EXIT=$?',
      '',
    ].join('\n'),
  )
  const mounts: string[] = [
    '-v', options.traceDir + ':' + tracePath,
    '-v', options.verifyDir + ':' + CONTAINER_PATHS.verifyDir,
    '-v', options.promptFile + ':' + CONTAINER_PATHS.promptFile + ':ro',
    '-v', runScript + ':' + CONTAINER_PATHS.runScript + ':ro',
  ]
  if (container.mountWorkspace !== false) {
    mounts.push('-v', options.workspaceDir + ':' + container.workspace)
  }
  for (const mount of container.mounts ?? []) {
    const source = renderContainerValue(mount.source, vars)
    const target = renderContainerValue(mount.target, vars)
    mounts.push('-v', source + ':' + target + (mount.readOnly === true ? ':ro' : ''))
  }
  const envArgs: string[] = []
  for (const entry of container.env ?? []) {
    envArgs.push('-e', renderContainerValue(entry.name, vars) + '=' + renderContainerValue(entry.value, vars))
  }
  const started = Date.now()
  const result = spawnSync(
    'docker',
    [
      'run', '--rm',
      ...mounts,
      ...envArgs,
      '-w', container.workspace,
      renderContainerValue(container.image, vars),
      'bash', CONTAINER_PATHS.runScript,
    ],
    { encoding: 'utf8', timeout: options.timeoutMs, windowsHide: true },
  )
  const durationMs = Date.now() - started
  const log = (result.stdout ?? '') + (result.stderr ?? '')
  writeFileSync(options.logPath, log)
  const agentExit = marker(log, 'AGENT_EXIT')
  const verifyExit = marker(log, 'VERIFY_EXIT')
  return {
    exitCode: result.status,
    timedOut: result.error !== undefined && String(result.error).includes('ETIMEDOUT'),
    durationMs,
    log,
    agentExit,
    verifyExit,
    verify: readVerifier(options.verifyDir),
  }
}

function readVerifier(verifyDir: string): VerifyResult {
  const junitPath = join(verifyDir, 'junit.xml')
  if (!existsSync(junitPath)) {
    return { ok: false, passed: 0, total: 0, checks: [], logPath: verifyDir, error: 'verifier: no junit report produced' }
  }
  try {
    const checks = parseJunit(readFileSync(junitPath, 'utf8'))
    const passed = checks.filter((check) => check.pass).length
    return { ok: checks.length > 0 && passed === checks.length, passed, total: checks.length, checks, logPath: junitPath }
  } catch (error) {
    return { ok: false, passed: 0, total: 0, checks: [], logPath: junitPath, error: 'verifier: unreadable junit report (' + String(error) + ')' }
  }
}

function marker(log: string, name: string): number | null {
  const match = new RegExp('^' + name + '=(\\d+)$', 'mu').exec(log)
  return match === null ? null : Number(match[1])
}

function shellQuote(value: string): string {
  return "'" + value.replace(/'/gu, "'\\''") + "'"
}

function lastLine(text: string | null | undefined): string {
  const lines = (text ?? '').split(/\r?\n/u).filter((line) => line.trim() !== '')
  return lines.length === 0 ? '' : (lines[lines.length - 1] as string).slice(0, 200)
}
