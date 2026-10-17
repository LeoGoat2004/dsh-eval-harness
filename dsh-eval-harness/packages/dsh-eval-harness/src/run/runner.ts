import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { loadBenchmarkFromManifest } from '../benchmark/interpreter.ts'
import { loadManifest } from '../benchmark/manifest.ts'
import {
  buildPrompt,
  findSessionLog,
  materializeProfile,
  prepareWorkspace,
  runEpisode,
  writeJson,
  writeTaskOverlay,
} from './profile.ts'
import { foldMetrics, normalizeEvents, readTrace, type TraceMetrics } from './collect.ts'
import {
  containerImageCheck,
  containerVars,
  dockerRuntimeCheck,
  renderContainerValue,
  runContainerEpisode,
} from './container.ts'
import { probeRequirements, type EnvironmentProbe, type EnvironmentRequirement } from './environment.ts'
import type { ModelTarget } from '../model/target.ts'
import type { LoopGuardLimits, LoopGuardTrip } from './guard.ts'
import { runManifestVerifier, type VerifyResult } from './verify.ts'

/** Explicit run definition. Every field is caller-supplied; nothing is defaulted. */
export interface RunSpec {
  readonly benchmarkRoot: string
  readonly benchmarkRevision: string
  readonly language: string
  readonly taskIds: readonly string[]
  readonly dshBin: string
  readonly dshVersion: string
  readonly outputDir: string
  readonly profileName: string
  readonly timeoutMs: number
  /** Sandbox/permission mode under test; explicit because it changes behaviour. */
  readonly permissionMode: 'workspace-write' | 'danger-full-access'
  readonly env: NodeJS.ProcessEnv
  /** Confirmed model target: pinned into the eval profile and verified from the trace. */
  readonly model: ModelTarget
  /** Declarative benchmark manifest; every run names its benchmark explicitly. */
  readonly manifestPath: string
  /** Explicit circuit-breaker limits for each episode. */
  readonly guard: LoopGuardLimits
}

/** Per-task outcome recorded into the run. */
export interface TaskSummary {
  readonly id: string
  readonly dir: string
  readonly status: 'passed' | 'failed' | 'error'
  readonly exitCode: number | null
  readonly timedOut: boolean
  readonly durationMs: number
  readonly sessionLog: string | null
  readonly metrics: TraceMetrics | null
  readonly verify: VerifyResult | null
  /** Provider/model the trace actually requested, when a request header exists. */
  readonly observedModel: { readonly provider: string; readonly model: string } | null
  /** Trace rows whose payload mentions the user home directory (isolation leak). */
  readonly homeLeaks: readonly { readonly seq: number; readonly type: string }[]
  /** Set when the loop guard stopped this episode. */
  readonly guard: LoopGuardTrip | null
  readonly error?: string
}

/** Whole-run outcome. */
export interface RunSummary {
  readonly runId: string
  readonly runDir: string
  readonly reportPath: string
  readonly tasks: readonly TaskSummary[]
  readonly totals: {
    readonly tasks: number
    readonly passed: number
    readonly failed: number
    readonly errored: number
    readonly durationMs: number
    readonly totalTokens: number
    readonly toolCalls: number
  }
}

/**
 * Execute one evaluation run: materialize the eval profile, run each explicit
 * task as a real headless `dsh` episode, harvest its trace, run the benchmark's
 * native verifier, and persist every artifact.
 * @param spec - the explicit run definition.
 * @returns run identity plus per-task summaries.
 */
export async function runEvaluation(spec: RunSpec): Promise<RunSummary> {
  validateSpec(spec)
  const startedAt = Date.now()

  const loadedManifest = loadManifest(spec.manifestPath)
  const benchmark = await loadBenchmarkFromManifest(
    loadedManifest,
    spec.benchmarkRoot,
    spec.language,
    spec.taskIds,
    spec.benchmarkRevision,
  )
  const runId = createRunId(spec, benchmark.name)
  const runDir = join(spec.outputDir, runId)
  mkdirSync(join(runDir, 'tasks'), { recursive: true })
  const dshHome = join(runDir, 'dsh-home')
  const profile = materializeProfile(dshHome, spec.profileName, spec.model)

  // Environment facts are part of the result: a lab-side failure must never be
  // reported as a DSH defect. Preflight fails fast when the environment is not
  // ready, so the user configures it before any model call is spent.
  const containerExecution =
    loadedManifest.manifest.execution?.kind === 'container'
      ? (loadedManifest.manifest.execution.container ?? null)
      : null
  const containerChecks: PreflightCheck[] = []
  if (containerExecution !== null) {
    const docker = dockerRuntimeCheck()
    containerChecks.push({ name: 'container-runtime', ok: docker.ok, detail: docker.detail })
    if (docker.ok) {
      const images = new Set<string>()
      for (const task of benchmark.tasks) {
        images.add(
          renderContainerValue(
            containerExecution.image,
            containerVars(loadedManifest.manifest, task, { taskDir: task.exerciseDir, artifactDir: '', traceDir: '' }),
          ),
        )
      }
      for (const image of images) {
        const check = containerImageCheck(image)
        containerChecks.push({ name: 'container-image:' + image, ok: check.ok, detail: check.detail })
      }
    }
  }
  const preflight = preflightEnvironment(
    spec,
    runDir,
    dshHome,
    profile.profileName,
    benchmark.environment,
    containerChecks,
  )
  writeJson(join(runDir, 'preflight.json'), preflight)
  if (!preflight.ok) {
    const failed = preflight.checks.filter((check) => !check.ok)
    throw new Error(
      'run: environment not ready: ' +
        failed.map((check) => check.name + ' — ' + check.detail).join('; '),
    )
  }

  writeJson(join(runDir, 'run.json'), {
    runId,
    benchmark: benchmark.name,
    benchmarkRevision: benchmark.revision,
    manifestPath: spec.manifestPath ?? null,
    language: benchmark.language,
    tasks: [...benchmark.tasks.map((task) => task.id)],
    dshVersion: spec.dshVersion,
    dshBin: spec.dshBin,
    profile: profile.profileName,
    backend: 'local',
    model: spec.model,
    timeoutMs: spec.timeoutMs,
    permissionMode: spec.permissionMode,
    guard: spec.guard,
    startedAt: new Date(startedAt).toISOString(),
    environment: { recorded: true, ...preflight.environment },
    artifacts: { trace: 'uncompressed JSONL', notes: 'test files never enter the agent workspace' },
  })

  const summaries: TaskSummary[] = []
  for (const [index, task] of benchmark.tasks.entries()) {
    const taskDir = join(runDir, 'tasks', String(index + 1).padStart(2, '0') + '-' + task.id)
    const workspaceDir = join(taskDir, 'workspace')
    const traceDir = join(taskDir, 'trace')
    mkdirSync(taskDir, { recursive: true })
    const prompt = buildPrompt(task)
    writeFileSync(join(taskDir, 'prompt.md'), prompt + '\n')
    mkdirSync(join(taskDir, 'agent'), { recursive: true })
    let episode: {
      exitCode: number | null
      timedOut: boolean
      durationMs: number
      guard: { readonly reason: string } | null
      verify: VerifyResult
    }
    if (containerExecution !== null) {
      if (containerExecution.mountWorkspace !== false) prepareWorkspace(task, workspaceDir)
      else mkdirSync(workspaceDir, { recursive: true })
      // The trace directory is mounted into the container; point the session
      // writer at the container-side path so JSONL lands on the host mount.
      mkdirSync(traceDir, { recursive: true })
      writeFileSync(
        join(traceDir, 'overlay.yml'),
        [
          '- id: session-persistence-jsonl',
          "  name: '@deepseek-ai/dsh-session-persistence-jsonl'",
          '  config:',
          "    root: '" + (containerExecution.tracePath ?? '/trace') + "'",
          '    compression: none',
          '',
        ].join('\n'),
      )
      const containerEpisode = runContainerEpisode({
        manifest: loadedManifest.manifest,
        task,
        taskDir,
        taskSourceDir: task.exerciseDir,
        workspaceDir,
        traceDir,
        verifyDir: join(taskDir, 'verify'),
        promptFile: join(taskDir, 'prompt.md'),
        dshHome,
        profileName: profile.profileName,
        runEnv: spec.env,
        timeoutMs: spec.timeoutMs,
        logPath: join(taskDir, 'agent', 'container.log'),
      })
      writeFileSync(join(taskDir, 'agent', 'stdout.log'), containerEpisode.log)
      writeFileSync(join(taskDir, 'agent', 'stderr.log'), '')
      episode = {
        exitCode: containerEpisode.exitCode,
        timedOut: containerEpisode.timedOut,
        durationMs: containerEpisode.durationMs,
        guard: null,
        verify: containerEpisode.verify,
      }
    } else {
      prepareWorkspace(task, workspaceDir)
      const overlayPath = writeTaskOverlay(taskDir, traceDir)
      const hostEpisode = await runEpisode({
        dshBin: spec.dshBin,
        dshHome,
        profileName: profile.profileName,
        overlayPath,
        workspaceDir,
        traceDir,
        prompt,
        env: spec.env,
        timeoutMs: spec.timeoutMs,
        limits: spec.guard,
      })
      writeFileSync(join(taskDir, 'agent', 'stdout.log'), hostEpisode.stdout)
      writeFileSync(join(taskDir, 'agent', 'stderr.log'), hostEpisode.stderr)
      episode = {
        exitCode: hostEpisode.exitCode,
        timedOut: hostEpisode.timedOut,
        durationMs: hostEpisode.durationMs,
        guard: hostEpisode.guard,
        verify: runManifestVerifier({
          manifest: loadedManifest.manifest,
          task,
          workspaceDir,
          taskDir,
          timeoutMs: 120_000,
        }),
      }
    }

    const sessionLog = findSessionLog(traceDir)
    let metrics: TraceMetrics | null = null
    let traceError: string | undefined
    let observedModel: TaskSummary['observedModel'] = null
    let homeLeaks: { seq: number; type: string }[] = []
    if (sessionLog !== null) {
      try {
        const trace = readTrace(sessionLog)
        writeFileSync(join(taskDir, 'events.jsonl'), normalizeEvents(trace).join('\n') + '\n')
        metrics = foldMetrics(trace.events)
        writeJson(join(taskDir, 'metrics.json'), metrics)
        observedModel = readObservedModel(trace.events)
        homeLeaks = findHomeLeaks(trace.events)
      } catch (error) {
        traceError = 'trace: ' + String(error)
      }
    }

    const verify = episode.verify
    writeJson(join(taskDir, 'checks.json'), verify)

    const status: TaskSummary['status'] =
      sessionLog === null || traceError !== undefined || episode.guard !== null
        ? 'error'
        : verify.ok
          ? 'passed'
          : 'failed'
    const summary: TaskSummary = {
      id: task.id,
      dir: taskDir,
      status,
      exitCode: episode.exitCode,
      timedOut: episode.timedOut,
      durationMs: episode.durationMs,
      sessionLog,
      metrics,
      verify,
      observedModel,
      homeLeaks,
      guard: episode.guard,
      ...(traceError === undefined ? {} : { error: traceError }),
    }
    summaries.push(summary)
    writeJson(join(taskDir, 'task.json'), {
      id: summary.id,
      status: summary.status,
      exitCode: summary.exitCode,
      timedOut: summary.timedOut,
      durationMs: summary.durationMs,
      sessionLog: summary.sessionLog,
      observedModel: summary.observedModel,
      homeLeaks: summary.homeLeaks,
      guard: summary.guard,
      checks: { passed: verify.passed, total: verify.total, ok: verify.ok },
      ...(summary.error === undefined ? {} : { error: summary.error }),
    })
  }

  const totals = summarize(summaries, Date.now() - startedAt)
  writeFileSync(
    join(runDir, 'tasks.jsonl'),
    summaries.map((summary) => JSON.stringify({ id: summary.id, status: summary.status })).join('\n') + '\n',
  )
  const reportPath = join(runDir, 'report.json')
  writeJson(reportPath, {
    manifest: {
      runId,
      benchmark: benchmark.name,
      benchmarkRevision: benchmark.revision,
      dshVersion: spec.dshVersion,
      profile: profile.profileName,
      model: spec.model,
      backend: 'local',
    },
    benchmark: { name: benchmark.name, language: benchmark.language, tasks: benchmark.tasks.map((task) => task.id) },
    config: { dshVersion: spec.dshVersion, profile: profile.profileName, model: spec.model, backend: 'local', guard: spec.guard },
    environment: { recorded: true, ...preflight.environment },
    modelVerification: summarizeModelVerification(spec.model, summaries),
    isolation: summarizeIsolation(summaries),
    tasks: summaries.map((summary) => ({
      id: summary.id,
      status: summary.status,
      durationMs: summary.durationMs,
      metrics: summary.metrics,
      guard: summary.guard,
      checks: summary.verify === null ? null : { passed: summary.verify.passed, total: summary.verify.total, ok: summary.verify.ok },
    })),
    totals,
  })
  return { runId, runDir, reportPath, tasks: summaries, totals }
}

/** Build the run id: benchmark, language, task count, UTC timestamp. */
function createRunId(spec: RunSpec, benchmarkName: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z')
  return benchmarkName.toLowerCase().replace(/[^a-z0-9]+/gu, '-') + '__' + spec.language + spec.taskIds.length + '__' + stamp
}

function summarize(summaries: readonly TaskSummary[], durationMs: number): RunSummary['totals'] {
  let passed = 0
  let failed = 0
  let errored = 0
  let totalTokens = 0
  let toolCalls = 0
  for (const summary of summaries) {
    if (summary.status === 'passed') passed += 1
    else if (summary.status === 'failed') failed += 1
    else errored += 1
    totalTokens += summary.metrics?.totalTokens ?? 0
    toolCalls += summary.metrics?.toolCalls ?? 0
  }
  return { tasks: summaries.length, passed, failed, errored, durationMs, totalTokens, toolCalls }
}

/** One task's isolation outcome. */
export interface IsolationSummary {
  readonly clean: boolean
  readonly homeDirLeaks: readonly { readonly task: string; readonly seq: number; readonly type: string }[]
}

/** Aggregate user-home leakage across tasks; the path itself is never stored. */
function summarizeIsolation(summaries: readonly TaskSummary[]): IsolationSummary {
  const homeDirLeaks = summaries.flatMap((summary) =>
    summary.homeLeaks.map((leak) => ({ task: summary.id, seq: leak.seq, type: leak.type })),
  )
  return { clean: homeDirLeaks.length === 0, homeDirLeaks }
}

/** Read the first request header's provider/model from raw trace events. */
function readObservedModel(
  events: readonly unknown[],
): { readonly provider: string; readonly model: string } | null {
  for (const event of events) {
    const candidate = event as {
      readonly type?: string
      readonly data?: {
        readonly header?: {
          readonly config?: { readonly provider?: string; readonly model?: string }
        }
      }
    }
    if (candidate.type !== 'request/header') continue
    const config = candidate.data?.header?.config
    if (config?.provider !== undefined && config.model !== undefined) {
      return { provider: config.provider, model: config.model }
    }
  }
  return null
}

/** Normalize separators so JSON-escaped backslashes still compare as paths. */
function normalizePathText(text: string): string {
  return text.toLowerCase().replace(/[\\/]+/gu, '/')
}

/** Find trace rows whose payload mentions the user home directory (prompt leak). */
function findHomeLeaks(events: readonly unknown[]): { seq: number; type: string }[] {
  const home = normalizePathText(homedir())
  const leaks: { seq: number; type: string }[] = []
  for (const event of events) {
    const candidate = event as { readonly seq?: number; readonly type?: string; readonly data?: unknown }
    if (typeof candidate.seq !== 'number' || typeof candidate.type !== 'string') continue
    let text: string
    try {
      text = JSON.stringify(candidate.data ?? '')
    } catch {
      continue
    }
    if (normalizePathText(text).includes(home)) {
      leaks.push({ seq: candidate.seq, type: candidate.type })
    }
  }
  return leaks
}

/**
 * Compare the declared model target with what the traces actually requested.
 * A mismatch means the recorded declaration is not what ran, so the report must
 * say so instead of trusting the manifest.
 */
function summarizeModelVerification(
  declared: ModelTarget,
  summaries: readonly TaskSummary[],
): {
  readonly declared: { readonly provider: string; readonly model: string }
  readonly observed: { readonly provider: string; readonly model: string } | null
  readonly ok: boolean | null
  readonly tasks: readonly { readonly id: string; readonly observedModel: TaskSummary['observedModel'] }[]
} {
  const observedTasks = summaries.map((summary) => ({ id: summary.id, observedModel: summary.observedModel }))
  const first = observedTasks.find((entry) => entry.observedModel !== null)?.observedModel ?? null
  return {
    declared: { provider: declared.provider, model: declared.model },
    observed: first,
    ok:
      first === null
        ? null
        : first.provider === declared.provider && first.model === declared.model,
    tasks: observedTasks,
  }
}

/** One preflight observation about the evaluation environment. */
interface PreflightCheck {
  readonly name: string
  readonly ok: boolean
  readonly detail: string
}

/** Environment facts persisted with every run and shown on the dashboard. */
export interface RunEnvironment {
  readonly backend: 'local' | 'docker'
  readonly platform: string
  readonly arch: string
  readonly node: string
  readonly workspaceRoot: string
  readonly dshHome: string
  readonly profile: string
  readonly sandbox: string
  readonly approval: string
  readonly network: { readonly policy: 'direct' | 'proxy-configured' }
  /** Benchmark-declared environment requirements and their probe results. */
  readonly requirements: readonly EnvironmentProbe[]
  /** Confirmed model target (credential value never recorded). */
  readonly model: {
    readonly provider: string
    readonly model: string
    readonly api: string | null
    readonly baseURL: string | null
    readonly apiKeyEnv: string
  }
}

/** Result of the environment preflight written before any episode starts. */
export interface PreflightReport {
  readonly ok: boolean
  readonly checks: readonly PreflightCheck[]
  readonly environment: RunEnvironment
}

/**
 * Probe the local evaluation environment before spending model calls. A lab
 * failure must never enter the results as a DSH defect, so the run records what
 * the environment was and refuses to start when it is unusable.
 * @param spec - run definition.
 * @param runDir - run artifact directory.
 * @param dshHome - private Harness home for this run.
 * @param profileName - eval profile name.
 * @returns the recorded environment plus pass/fail checks.
 */
function preflightEnvironment(
  spec: RunSpec,
  runDir: string,
  dshHome: string,
  profileName: string,
  requirements: readonly EnvironmentRequirement[],
  extraChecks: readonly PreflightCheck[] = [],
): PreflightReport {
  const checks: PreflightCheck[] = [...extraChecks]
  let writable = true
  let writableDetail = 'run directory accepts writes'
  try {
    const probe = join(runDir, '.preflight-write-probe')
    writeFileSync(probe, 'ok')
    unlinkSync(probe)
  } catch (error) {
    writable = false
    writableDetail = 'cannot write a probe file: ' + String(error)
  }
  checks.push({ name: 'output-writable', ok: writable, detail: writableDetail })
  checks.push({ name: 'dsh-launcher', ok: existsSync(spec.dshBin), detail: spec.dshBin })
  checks.push({
    name: 'benchmark-revision-pinned',
    ok: spec.benchmarkRevision !== 'unknown',
    detail: spec.benchmarkRevision,
  })
  checks.push({
    name: 'model-credential',
    ok: (spec.env[spec.model.apiKeyEnv] ?? '') !== '',
    detail: spec.model.apiKeyEnv + ' for ' + spec.model.provider + '/' + spec.model.model,
  })
  checks.push({
    name: 'tasks-explicit',
    ok: spec.taskIds.length > 0,
    detail: spec.taskIds.join(', '),
  })
  const probes = probeRequirements(requirements)
  for (const probe of probes) {
    checks.push({ name: 'env:' + probe.id, ok: probe.ok, detail: probe.detail })
  }
  const env = spec.env
  const proxyConfigured = Boolean(env.HTTP_PROXY ?? env.HTTPS_PROXY ?? env.ALL_PROXY)
  return {
    ok: checks.every((check) => check.ok),
    checks,
    environment: {
      backend: 'local',
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      workspaceRoot: runDir,
      dshHome,
      profile: profileName,
      sandbox: 'workspace-write',
      approval: 'non-interactive (no approver)',
      network: { policy: proxyConfigured ? 'proxy-configured' : 'direct' },
      requirements: probes,
      model: {
        provider: spec.model.provider,
        model: spec.model.model,
        api: spec.model.api ?? null,
        baseURL: spec.model.baseURL ?? null,
        apiKeyEnv: spec.model.apiKeyEnv,
      },
    },
  }
}

function validateSpec(spec: RunSpec): void {
  if (spec.taskIds.length === 0) throw new Error('run: at least one explicit task id is required')
  if (!existsSync(spec.benchmarkRoot)) throw new Error('run: benchmark root does not exist: ' + spec.benchmarkRoot)
  if (!existsSync(spec.dshBin)) throw new Error('run: dsh launcher does not exist: ' + spec.dshBin)
  if (!Number.isFinite(spec.timeoutMs) || spec.timeoutMs <= 0) throw new Error('run: timeoutMs must be positive')
  if ((spec.env[spec.model.apiKeyEnv] ?? '') === '') {
    throw new Error('run: model credential env ' + spec.model.apiKeyEnv + ' is missing from the child environment')
  }
  if (spec.guard.maxSteps <= 0 || spec.guard.maxIdenticalToolCalls <= 0) {
    throw new Error('run: loop-guard limits must be positive')
  }
  if (spec.permissionMode !== 'workspace-write' && spec.permissionMode !== 'danger-full-access') {
    throw new Error('run: permissionMode must be workspace-write or danger-full-access')
  }
}

/** Read the evaluated dsh version from an installed package manifest. */
export function readDshVersion(dshBin: string): string {
  const manifest = readFileSync(join(dshBin, '..', '..', 'package.json'), 'utf8')
  const parsed = JSON.parse(manifest) as { version?: unknown }
  return typeof parsed.version === 'string' ? parsed.version : 'unknown'
}


