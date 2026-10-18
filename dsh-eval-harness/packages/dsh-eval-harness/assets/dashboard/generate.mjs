// Standalone dashboard generator shipped with the plugin package.
//
// The dashboard app builds to one self-contained HTML file; this module reads a
// run's artifacts, derives the dashboard data contract, injects it, and writes
// `<run>/dashboard/index.html`. It never mutates run evidence.
//
// It is plain ESM on purpose: it runs both from the installed package (called by
// `eval_run`) and from the development checkout (called by `scripts/dashboard.mjs`).
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { classifyToolFailure } from '../../lib/run/attribution.js'

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * Generate the standalone dashboard for one run.
 * @param {string} runDir - absolute run directory.
 * @param {{ templatePath?: string }} [options] - optional template override.
 * @returns {{ dashboard: string, bytes: number, tasks: number, findings: number }}
 */
export function generateDashboard(runDir, options = {}) {
  const resolvedRun = resolve(runDir)
  const templatePath = options.templatePath ?? join(PACKAGE_ROOT, 'assets', 'dashboard', 'index.html')
  if (!existsSync(templatePath)) {
    throw new Error('dashboard: template is missing: ' + templatePath)
  }
  const run = readJson(join(resolvedRun, 'run.json'))
  const report = readJson(join(resolvedRun, 'report.json'))
  const tasksDir = join(resolvedRun, 'tasks')
  const taskDirs = readdirSync(tasksDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
  const tasks = taskDirs.map((directory) => buildTask(join(tasksDir, directory), directory))
  // Core diagnostics live in report.json; the dashboard only presents them. The
  // trace-based derivation is a fallback for runs that predate the field.
  const findings =
    Array.isArray(report.diagnostics) && report.diagnostics.length > 0
      ? findingsFromDiagnostics(report.diagnostics)
      : deriveFindings(tasks)
  const computedIsolation = computeIsolation(tasks)
  const isolation = computedIsolation.clean ? (report.isolation ?? computedIsolation) : computedIsolation
  const data = {
    generatedAt: new Date().toISOString(),
    manifest: {
      runId: run.runId,
      benchmark: run.benchmark,
      benchmarkRevision: run.benchmarkRevision,
      dshVersion: run.dshVersion,
      profile: run.profile,
      model: run.model,
      backend: run.backend,
      timeoutMs: run.timeoutMs,
      startedAt: run.startedAt,
    },
    benchmark: {
      name: report.benchmark.name,
      language: report.benchmark.language,
      tasks: report.benchmark.tasks,
    },
    environment: run.environment ?? { recorded: false, backend: run.backend },
    modelVerification: report.modelVerification ?? null,
    isolation,
    totals: {
      tasks: report.totals.tasks,
      passed: report.totals.passed,
      failed: report.totals.failed,
      ungraded: report.totals.ungraded,
      executionErrors: report.totals.executionErrors,
      durationMs: report.totals.durationMs,
      totalTokens: report.totals.totalTokens,
      toolCalls: report.totals.toolCalls,
      toolErrors: tasks.reduce((total, task) => total + (task.metrics?.toolErrors ?? 0), 0),
    },
    tasks,
    findings,
  }
  const html = readFileSync(templatePath, 'utf8')
  const payload = '<script>window.__DASHBOARD_DATA__ = ' + JSON.stringify(data).replace(/</gu, '\\u003c') + ';</script>'
  const injected = html.replace('</head>', payload + '</head>')
  if (injected === html) throw new Error('dashboard: could not inject data (no </head> in the template)')
  const outputDir = join(resolvedRun, 'dashboard')
  mkdirSync(outputDir, { recursive: true })
  const outputPath = join(outputDir, 'index.html')
  writeFileSync(outputPath, injected)
  return { dashboard: outputPath, bytes: statSync(outputPath).size, tasks: tasks.length, findings: findings.length }
}

/** Read one task's artifacts into the dashboard data contract. */
function buildTask(taskDir, directory) {
  const id = directory.replace(/^\d+-/u, '')
  const taskInfo = readOptionalJson(join(taskDir, 'task.json'))
  const metrics = readOptionalJson(join(taskDir, 'metrics.json'))
  const checks = readOptionalJson(join(taskDir, 'checks.json'))
  const events = readOptionalEvents(join(taskDir, 'events.jsonl'))
  return {
    id,
    status:
      taskInfo?.taskOutcome === 'passed'
        ? 'passed'
        : taskInfo?.taskOutcome === 'failed'
          ? 'failed'
          : 'error',
    executionStatus: taskInfo?.executionStatus ?? 'not_started',
    taskOutcome: taskInfo?.taskOutcome ?? 'ungraded',
    durationMs: taskInfo?.durationMs ?? 0,
    exitCode: taskInfo?.exitCode ?? null,
    timedOut: taskInfo?.timedOut ?? false,
    metrics: metrics ?? null,
    checks:
      checks === null
        ? null
        : {
            passed: checks.passed ?? 0,
            total: checks.total ?? 0,
            ok: checks.ok === true,
            ...(checks.error === undefined ? {} : { error: checks.error }),
            items: checks.checks ?? [],
          },
    ...(taskInfo?.error === undefined ? {} : { error: taskInfo.error }),
    ...(taskInfo?.guard === undefined || taskInfo.guard === null ? {} : { guard: taskInfo.guard }),
    ...(taskInfo?.observedModel === undefined ? {} : { observedModel: taskInfo.observedModel }),
    events,
    artifacts: {
      trace: taskInfo?.sessionLog ?? null,
      workspace: join(taskDir, 'workspace'),
      verifyLog: checks === null ? null : join(taskDir, 'verify', 'pytest.log'),
    },
  }
}

/** Fallback isolation check for runs whose report predates the field. */
function computeIsolation(tasks) {
  const pattern = /[A-Za-z]:\\Users\\|\/Users\/|\/home\//u
  const homeDirLeaks = []
  for (const task of tasks) {
    for (const event of task.events) {
      const summary = typeof event.summary === 'string' ? event.summary : ''
      if (pattern.test(summary)) homeDirLeaks.push({ task: task.id, seq: event.seq, type: event.type })
    }
  }
  return { clean: homeDirLeaks.length === 0, homeDirLeaks }
}

/** Derive run-level findings from trace events (fallback for old reports). */
function deriveFindings(tasks) {
  const groups = new Map()
  for (const task of tasks) {
    for (const event of task.events) {
      if (event.error !== true) continue
      if (event.type !== 'tool/result' && event.type !== 'turn/end') continue
      const summary = typeof event.summary === 'string' ? event.summary : ''
      const classification = classifyToolFailure(summary)
      const label = normalizeLabel(summary)
      const key = classification.layer + '\u0000' + classification.kind + '\u0000' + label
      const group =
        groups.get(key) ??
        {
          kind: classification.kind,
          layer: classification.layer,
          note: classification.note,
          label,
          count: 0,
          confidence: confidenceOf(classification.confidence),
          tasks: new Set(),
        }
      group.count += 1
      group.tasks.add(task.id)
      groups.set(key, group)
    }
  }
  return [...groups.values()]
    .sort((a, b) => b.count - a.count)
    .map((group) => ({
      kind: group.kind,
      layer: group.layer,
      note: group.note,
      label: group.label,
      count: group.count,
      tasks: [...group.tasks],
      confidence: group.confidence ?? 'unresolved',
    }))
}

/** Map core diagnostics into the dashboard's finding shape. */
function findingsFromDiagnostics(diagnostics) {
  return diagnostics.map((diagnostic) => {
    const evidence = Array.isArray(diagnostic.evidence) ? diagnostic.evidence : []
    const tasks = [...new Set(evidence.map((item) => item.taskId).filter((id) => typeof id === 'string'))]
    return {
      kind: diagnostic.kind,
      layer: diagnostic.layer,
      note: diagnostic.note,
      label: diagnostic.note,
      count: Math.max(1, evidence.length),
      tasks,
      confidence: confidenceOf(diagnostic.confidence),
    }
  })
}

/** Map core confidence vocabulary to the dashboard's display vocabulary. */
function confidenceOf(confidence) {
  if (confidence === 'confirmed') return 'confirmed'
  if (confidence === 'unresolved') return 'unresolved'
  return 'suspicious'
}

/** Normalize a failure message into a stable, machine-independent label. */
function normalizeLabel(text) {
  return text
    .replace(/[A-Za-z]:\\[^\s"']+/gu, '<path>')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 160)
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function readOptionalJson(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null
}

function readOptionalEvents(path) {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line))
}

/** CLI entry used by the development checkout. */
function main(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith('--')) continue
    args[argv[index].slice(2)] = argv[index + 1]
    index += 1
  }
  if (args.run === undefined) {
    console.error('dashboard: --run <run-dir> is required')
    process.exit(2)
  }
  const result = generateDashboard(args.run, args.dist === undefined ? {} : { templatePath: args.dist })
  console.log(JSON.stringify(result, null, 2))
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
}
