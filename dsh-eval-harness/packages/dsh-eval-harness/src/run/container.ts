import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BenchmarkTask } from '../benchmark/interpreter.ts'
import type { BenchmarkManifest } from '../benchmark/manifest.ts'
import { renderTemplate } from '../benchmark/manifest.ts'
import { createLoopGuard, type LoopGuardLimits, type LoopGuardTrip } from './guard.ts'
import { findSessionLog } from './profile.ts'
import { parseJunit, type Check, type VerifyResult } from './verify.ts'

/** One environment observation for container execution. */
export interface ContainerCheck {
  readonly ok: boolean
  readonly detail: string
}

/** Outcome of one container episode (two separate containers: agent, verifier). */
export interface ContainerEpisodeResult {
  readonly exitCode: number | null
  readonly timedOut: boolean
  readonly durationMs: number
  readonly log: string
  readonly agentExit: number | null
  readonly verifyExit: number | null
  /** Set when the loop guard stopped the agent container before the timeout. */
  readonly guard: LoopGuardTrip | null
  /** Audit of which verifier-only paths the agent could also see. */
  readonly graderVisibility: GraderVisibility
  /** Number of verifier attempts actually made (0 when grading was skipped). */
  readonly verifyAttempts: number
  readonly verify: VerifyResult
}

/** Records what the agent container can see relative to the verifier's files. */
export interface GraderVisibility {
  /** Mount targets the agent container received. */
  readonly agentMounts: readonly string[]
  /** Mount targets only the verifier received (the grader side). */
  readonly verifierOnlyMounts: readonly string[]
  /** Verifier mount targets reachable from an agent mount; should stay empty. */
  readonly exposedToAgent: readonly string[]
  /** True when agent and verifier share one image (baked-in graders are not excluded). */
  readonly sharedImage: boolean
}

/** Standard container paths the executor always provides. */
export const CONTAINER_PATHS = {
  agentScript: '/dsh-agent.sh',
  verifyScript: '/dsh-verify.sh',
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
 * Read the resolved digest of a local image; null when it cannot be inspected.
 * @param image - image reference.
 * @returns repo digest (or image id) for the reproducibility record.
 */
export function containerImageDigest(image: string): string | null {
  const result = spawnSync(
    'docker',
    ['image', 'inspect', '--format', '{{if .RepoDigests}}{{index .RepoDigests 0}}{{else}}{{.Id}}{{end}}', image],
    { encoding: 'utf8', timeout: 30_000, windowsHide: true },
  )
  const digest = (result.stdout ?? '').trim()
  return result.status === 0 && digest !== '' ? digest : null
}

/**
 * Render one container value: host-environment placeholders first, then task
 * variables. Unknown placeholders stay untouched so misconfiguration is visible.
 * @param value - template string.
 * @param vars - per-task variables.
 * @returns rendered string.
 */
export function renderContainerValue(
  value: string,
  vars: Readonly<Record<string, string>>,
  runEnv: NodeJS.ProcessEnv = process.env,
): string {
  const withEnv = value
    .replace(/\{\{\s*env:([A-Za-z0-9_]+)\s*\}\}/gu, (_match, name: string) => process.env[name] ?? '')
    .replace(/\{\{\s*runEnv:([A-Za-z0-9_]+)\s*\}\}/gu, (_match, name: string) => runEnv[name] ?? '')
  return renderTemplate(withEnv, vars)
}

/** Variables available to every container template. */
export function containerVars(
  manifest: BenchmarkManifest,
  task: BenchmarkTask,
  paths: {
    taskDir: string
    artifactDir: string
    traceDir: string
    dshHome?: string
    profileName?: string
  },
): Record<string, string> {
  const container = manifest.execution?.container
  const tracePath = container?.tracePath ?? '/trace'
  return {
    name: manifest.name,
    language: task.language,
    taskId: task.id,
    taskDir: paths.taskDir,
    artifactDir: paths.artifactDir,
    workspace: container?.workspace ?? '/app',
    tracePath,
    overlayFile: tracePath + '/overlay.yml',
    promptFile: CONTAINER_PATHS.promptFile,
    verifyDir: CONTAINER_PATHS.verifyDir,
    junitPath: CONTAINER_PATHS.junitPath,
    hostTraceDir: paths.traceDir,
    ...(paths.dshHome === undefined ? {} : { dshHome: paths.dshHome }),
    ...(paths.profileName === undefined ? {} : { profileName: paths.profileName }),
  }
}

/**
 * Run one episode as two containers: the agent container holds the workspace and
 * the model credential, then a verifier container receives only an artifact
 * snapshot and the read-only benchmark mounts. The verifier never sees the
 * prompt, trace, DSH home or model credential.
 *
 * The agent container is watched while it runs: the durable trace is mounted on
 * the host, so the same loop guard used for host episodes also stops runaway
 * container episodes at the same budget.
 * @param options - manifest, task, host directories, timeout, guard limits.
 * @returns process outcome, marker exits, guard trip and parsed checks.
 */
export async function runContainerEpisode(options: {
  readonly manifest: BenchmarkManifest
  readonly task: BenchmarkTask
  readonly taskDir: string
  readonly taskSourceDir: string
  readonly workspaceDir: string
  readonly traceDir: string
  readonly verifyDir: string
  readonly promptFile: string
  readonly dshHome?: string
  readonly profileName?: string
  readonly runEnv?: NodeJS.ProcessEnv
  readonly timeoutMs: number
  readonly guard: LoopGuardLimits
  readonly containerName?: string
  readonly logPath: string
}): Promise<ContainerEpisodeResult> {
  const container = options.manifest.execution?.container
  if (container === undefined) throw new Error('container execution: manifest has no execution.container block')
  const runEnv = options.runEnv ?? process.env
  mkdirSync(options.workspaceDir, { recursive: true })
  mkdirSync(options.traceDir, { recursive: true })
  mkdirSync(options.verifyDir, { recursive: true })
  const vars = containerVars(options.manifest, options.task, {
    taskDir: options.taskSourceDir,
    artifactDir: options.taskDir,
    traceDir: options.traceDir,
    ...(options.dshHome === undefined ? {} : { dshHome: options.dshHome }),
    ...(options.profileName === undefined ? {} : { profileName: options.profileName }),
  })
  const render = (value: string): string => renderContainerValue(value, vars, runEnv)
  const tracePath = container.tracePath ?? '/trace'
  const agentImage = render(container.agentImage ?? container.image)
  const verifierImage = render(container.verifierImage ?? container.image)
  const baseName = options.containerName ?? 'dsh-eval-' + randomUUID()
  const agentName = baseName + '-agent'
  const verifierName = baseName + '-verify'
  const started = Date.now()
  const renderMountSpecs = (
    specs: readonly { readonly source: string; readonly target: string; readonly readOnly?: boolean }[],
  ): { args: string[]; targets: string[] } => {
    const args: string[] = []
    const targets: string[] = []
    for (const mount of specs) {
      const target = render(mount.target)
      targets.push(target)
      args.push('-v', render(mount.source) + ':' + target + (mount.readOnly === true ? ':ro' : ''))
    }
    return { args, targets }
  }
  const agentExtraMounts = renderMountSpecs(container.agentMounts ?? [])
  // `mounts` is the legacy alias of verifierMounts; both are verifier-only and
  // may be combined without exposing anything to the agent.
  const verifierOnlyMounts = renderMountSpecs([...(container.mounts ?? []), ...(container.verifierMounts ?? [])])

  const renderCommand = (command: readonly string[]): string => command.map((token) => shellQuote(render(token))).join(' ')
  const agentScript = join(options.verifyDir, 'agent.sh')
  writeFileSync(
    agentScript,
    [
      '#!/bin/bash',
      'set +e',
      renderCommand(container.agentCommand),
      // Preserve the agent's status: without the explicit exit, the shell would
      // return 0 because the last statement (`echo`) succeeded.
      'AGENT_EXIT=$?',
      'echo AGENT_EXIT=$AGENT_EXIT',
      'exit $AGENT_EXIT',
      '',
    ].join('\n'),
  )
  const agentMounts: string[] = [
    '-v', options.traceDir + ':' + tracePath,
    '-v', options.promptFile + ':' + CONTAINER_PATHS.promptFile + ':ro',
    '-v', agentScript + ':' + CONTAINER_PATHS.agentScript + ':ro',
    ...agentExtraMounts.args,
  ]
  if (container.mountWorkspace !== false) agentMounts.push('-v', options.workspaceDir + ':' + container.workspace)
  if (container.mountDshHome === true) {
    if (options.dshHome === undefined) throw new Error('container execution: mountDshHome requires a dshHome')
    agentMounts.push('-v', options.dshHome + ':/dsh-home')
  }
  const agentEnv: string[] = []
  for (const entry of container.env ?? []) {
    agentEnv.push('-e', render(entry.name) + '=' + render(entry.value))
  }
  // Audit: a verifier-only path is exposed when the agent holds an ancestor
  // mount of it. The shared workspace is expected and excluded from the check.
  const agentVisibleTargets = [
    ...agentExtraMounts.targets,
    ...(container.mountWorkspace !== false ? [container.workspace] : []),
    ...(container.mountDshHome === true ? ['/dsh-home'] : []),
  ]
  const exposedToAgent = verifierOnlyMounts.targets.filter((target) => {
    if (target === container.workspace) return false
    return agentVisibleTargets.some((agentTarget) => {
      const prefix = agentTarget === '/' ? '/' : agentTarget.replace(/\/+$/u, '') + '/'
      return target === agentTarget || target.startsWith(prefix)
    })
  })
  const graderVisibility: GraderVisibility = {
    agentMounts: agentVisibleTargets,
    verifierOnlyMounts: verifierOnlyMounts.targets,
    exposedToAgent,
    sharedImage: agentImage === verifierImage,
  }

  const agent = await runDockerPhase({
    args: [
      'run',
      '--name', agentName,
      ...agentMounts,
      ...agentEnv,
      '-w', container.workspace,
      agentImage,
      'bash', CONTAINER_PATHS.agentScript,
    ],
    timeoutMs: options.timeoutMs,
    traceDir: options.traceDir,
    guard: options.guard,
    containerName: agentName,
  })
  const agentLog = agent.log
  // The marker is authoritative: the container's own exit code only proves that
  // the wrapper shell finished.
  const agentExit = marker(agentLog, 'AGENT_EXIT') ?? agent.exitCode
  const agentOk = agentExit === 0 && !agent.timedOut && agent.guard === null

  let artifactError: string | undefined
  // Evidence sources for the verifier. Each is copied to a fresh disposable
  // directory before every verifier attempt, so a writable grader can never
  // rewrite the agent's evidence.
  const verifierSources: { readonly evidenceDir: string; readonly target: string }[] = []
  const writable = container.verifyWorkspace === 'read-write' ? '' : ':ro'
  if (agentOk) {
    if (container.mountWorkspace !== false) {
      verifierSources.push({ evidenceDir: options.workspaceDir, target: container.workspace })
    } else {
      const artifacts = container.artifacts ?? []
      if (artifacts.length === 0) {
        artifactError = 'container execution: manifest declares no artifacts for an image-content benchmark'
      }
      artifacts.forEach((artifactPath, index) => {
        if (artifactError !== undefined) return
        const hostDir = join(options.taskDir, 'artifacts', String(index))
        mkdirSync(hostDir, { recursive: true })
        const copy = spawnSync('docker', ['cp', agentName + ':' + artifactPath + '/.', hostDir], {
          encoding: 'utf8',
          timeout: 120_000,
          windowsHide: true,
        })
        if (copy.status !== 0) {
          artifactError = 'container execution: artifact snapshot failed for ' + artifactPath + ': ' + lastLine(copy.stderr)
          return
        }
        verifierSources.push({ evidenceDir: hostDir, target: artifactPath })
      })
    }
  }
  // The agent container is disposable once the snapshot exists.
  spawnSync('docker', ['rm', '-f', agentName], { stdio: 'ignore', windowsHide: true })

  if (!agentOk) {
    const log = agentLog
    writeFileSync(options.logPath, log)
    return {
      exitCode: agentExit,
      timedOut: agent.timedOut,
      durationMs: Date.now() - started,
      log,
      agentExit,
      verifyExit: null,
      guard: agent.guard,
      graderVisibility,
      verifyAttempts: 0,
      verify: {
        ok: false,
        passed: 0,
        total: 0,
        checks: [],
        logPath: options.verifyDir,
        error: 'verifier: skipped because the agent episode did not complete',
      },
    }
  }
  if (artifactError !== undefined) {
    const log = agentLog
    writeFileSync(options.logPath, log)
    return {
      exitCode: agentExit,
      timedOut: false,
      durationMs: Date.now() - started,
      log,
      agentExit,
      verifyExit: null,
      guard: null,
      graderVisibility,
      verifyAttempts: 0,
      verify: { ok: false, passed: 0, total: 0, checks: [], logPath: options.verifyDir, error: artifactError },
    }
  }

  const verifyScript = join(options.verifyDir, 'verify.sh')
  writeFileSync(
    verifyScript,
    ['#!/bin/bash', 'set +e', renderCommand(container.verifyCommand), 'echo VERIFY_EXIT=$?', ''].join('\n'),
  )
  const verifyEnv: string[] = []
  for (const entry of container.verifyEnv ?? []) {
    verifyEnv.push('-e', render(entry.name) + '=' + render(entry.value))
  }
  // A benchmark's verifier bootstrap may install test dependencies over the
  // network; a transient failure must not be reported as a task failure. Only
  // retry when the run failed without a usable judgement, and only on known
  // transient signatures.
  const maxAttempts = 1 + Math.min(3, Math.max(0, container.verifyRetries ?? 1))
  let attempts = 0
  let verifyExit: number | null = null
  let verifyLog = ''
  let verifyResult: VerifyResult = {
    ok: false,
    passed: 0,
    total: 0,
    checks: [],
    logPath: options.verifyDir,
    error: 'verifier: did not run',
  }
  while (attempts < maxAttempts) {
    attempts += 1
    const attemptMounts: string[] = []
    verifierSources.forEach((source, index) => {
      const copy = join(options.verifyDir, 'attempt-' + String(attempts), String(index))
      rmSync(copy, { recursive: true, force: true })
      mkdirSync(copy, { recursive: true })
      cpSync(source.evidenceDir, copy, { recursive: true, force: true })
      attemptMounts.push('-v', copy + ':' + source.target + writable)
    })
    const verifier = await runDockerPhase({
      args: [
        'run',
        '--name', verifierName,
        ...attemptMounts,
        ...verifierOnlyMounts.args,
        ...verifyEnv,
        '-v', options.verifyDir + ':' + CONTAINER_PATHS.verifyDir,
        '-v', verifyScript + ':' + CONTAINER_PATHS.verifyScript + ':ro',
        '-w', container.workspace,
        verifierImage,
        'bash', CONTAINER_PATHS.verifyScript,
      ],
      timeoutMs: Math.min(options.timeoutMs, 300_000),
      containerName: verifierName,
    })
    spawnSync('docker', ['rm', '-f', verifierName], { stdio: 'ignore', windowsHide: true })
    verifyExit = verifier.timedOut ? null : marker(verifier.log, 'VERIFY_EXIT') ?? verifier.exitCode
    verifyLog += '# verifier attempt ' + String(attempts) + '\n' + verifier.log
    verifyResult = verifier.timedOut
      ? { ok: false, passed: 0, total: 0, checks: [], logPath: options.verifyDir, error: 'verifier: timed out' }
      : readVerifier(options.verifyDir, container.verifyResult ?? 'junitxml', verifyExit, verifier.log)
    if (verifyResult.ok) break
    const transient = verifier.timedOut || (verifyExit !== 0 && isTransientVerifierFailure(verifier.log))
    if (!transient || attempts >= maxAttempts) break
  }
  const log = agentLog + verifyLog
  writeFileSync(options.logPath, log)
  return {
    exitCode: agentExit,
    timedOut: false,
    durationMs: Date.now() - started,
    log,
    agentExit,
    verifyExit,
    guard: null,
    graderVisibility,
    verifyAttempts: attempts,
    verify: verifyResult,
  }
}

/** Network/bootstrap failures that justify retrying a verifier once. */
export function isTransientVerifierFailure(log: string): boolean {
  const patterns = [
    '502 Bad Gateway',
    '503 Service',
    '504 Gateway',
    'Bad Gateway',
    'Temporary failure',
    'Could not resolve',
    'Name or service not known',
    'Connection timed out',
    'Operation timed out',
    'Network is unreachable',
    'Failed to fetch',
    'curl: (',
    'ETIMEDOUT',
    'ECONNRESET',
    'ECONNREFUSED',
  ]
  return patterns.some((pattern) => log.includes(pattern))
}

/** Run one docker phase, optionally polling the trace with the loop guard. */
async function runDockerPhase(options: {
  readonly args: readonly string[]
  readonly timeoutMs: number
  readonly traceDir?: string
  readonly guard?: LoopGuardLimits
  readonly containerName: string
}): Promise<{ exitCode: number | null; timedOut: boolean; guard: LoopGuardTrip | null; log: string }> {
  const child = spawn('docker', [...options.args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  const out: string[] = []
  const err: string[] = []
  child.stdout?.on('data', (chunk: Buffer) => out.push(chunk.toString('utf8')))
  child.stderr?.on('data', (chunk: Buffer) => err.push(chunk.toString('utf8')))
  const kill = (): void => {
    spawn('docker', ['kill', options.containerName], { stdio: 'ignore', windowsHide: true })
    spawn('docker', ['rm', '-f', options.containerName], { stdio: 'ignore', windowsHide: true })
  }
  return new Promise((resolve, reject) => {
    let settled = false
    const guard = options.guard === undefined ? null : createLoopGuard(options.guard)
    let processedLines = 0
    const finish = (result: { exitCode: number | null; timedOut: boolean; guard: LoopGuardTrip | null }): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (poller !== undefined) clearInterval(poller)
      resolve({ ...result, log: out.join('') + err.join('') })
    }
    const timer = setTimeout(() => {
      kill()
      finish({ exitCode: null, timedOut: true, guard: null })
    }, options.timeoutMs)
    let poller: NodeJS.Timeout | undefined
    if (guard !== null && options.traceDir !== undefined) {
      poller = setInterval(() => {
        if (settled) return
        const logPath = findSessionLog(options.traceDir as string)
        if (logPath === null) return
        let text: string
        try {
          text = readFileSync(logPath, 'utf8')
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
            return
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
            kill()
            finish({ exitCode: null, timedOut: false, guard: trip })
            return
          }
        }
      }, 2000)
    }
    child.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (poller !== undefined) clearInterval(poller)
      reject(error)
    })
    child.once('close', (code) => {
      finish({ exitCode: code, timedOut: false, guard: null })
    })
  })
}

/**
 * Parse per-test outcomes out of pytest's `-rA` text output. Container
 * benchmarks that do not emit junit still get per-test checks, and a skipped
 * test can never be counted as a pass.
 * @param log - verifier stdout/stderr.
 * @returns checks in report order.
 */
export function parsePytestText(log: string): Check[] {
  const checks: Check[] = []
  for (const line of log.split(/\r?\n/u)) {
    const match = /^(PASSED|FAILED|ERROR|SKIPPED)\s+(?:\[\d+\]\s+)?(\S+)/u.exec(line.trim())
    if (match === null) continue
    const status = match[1]
    checks.push({
      id: match[2] as string,
      pass: status === 'PASSED',
      skipped: status === 'SKIPPED',
    })
  }
  return checks
}

function readVerifier(
  verifyDir: string,
  format: 'junitxml' | 'pytest-text' | 'exit-code',
  verifyExit: number | null,
  log: string,
): VerifyResult {
  if (format === 'exit-code') {
    return { ok: verifyExit === 0, passed: 0, total: 0, checks: [], logPath: verifyDir }
  }
  if (format === 'pytest-text') {
    const checks = parsePytestText(log)
    const passed = checks.filter((check) => check.pass).length
    const skipped = checks.filter((check) => check.skipped).length
    const failed = checks.length - passed - skipped
    const total = checks.length > 0 ? checks.length : passed + failed
    return {
      ok: verifyExit === 0 && passed > 0 && failed === 0 && skipped === 0,
      passed,
      total,
      skipped,
      checks,
      logPath: verifyDir,
      ...(total === 0 ? { error: 'verifier: no pytest summary found in container output' } : {}),
    }
  }
  const junitPath = join(verifyDir, 'junit.xml')
  if (!existsSync(junitPath)) {
    return { ok: false, passed: 0, total: 0, checks: [], logPath: verifyDir, error: 'verifier: no junit report produced' }
  }
  try {
    const checks = parseJunit(readFileSync(junitPath, 'utf8'))
    const passed = checks.filter((check) => check.pass).length
    const skipped = checks.filter((check) => check.skipped).length
    return {
      ok: verifyExit === 0 && checks.length > 0 && passed === checks.length,
      passed,
      total: checks.length,
      skipped,
      checks,
      logPath: junitPath,
    }
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
