// Generate the standalone dashboard artifact for one run.
//
// The dashboard app builds to a single self-contained HTML file. This script
// reads the run artifacts, derives the dashboard data contract, injects it, and
// writes `<run>/dashboard/index.html`. It never mutates run evidence.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { classifyToolFailure } from '../packages/dsh-eval-harness/lib/run/attribution.js'

const args = parseArgs(process.argv.slice(2))
if (args.run === undefined) {
  console.error('dashboard: --run <run-dir> is required')
  process.exit(2)
}
const workspaceRoot = resolve(import.meta.dirname, '..')
const runDir = resolve(args.run)
const distHtml = resolve(args.dist ?? join(workspaceRoot, 'dashboard', 'dist', 'index.html'))
if (!existsSync(distHtml)) {
  console.error('dashboard: dashboard/dist/index.html is missing; run `npm run dashboard:app` first')
  process.exit(2)
}

const run = readJson(join(runDir, 'run.json'))
const report = readJson(join(runDir, 'report.json'))
const tasksDir = join(runDir, 'tasks')
const taskDirs = readdirSync(tasksDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()

const tasks = taskDirs.map((directory) => buildTask(join(tasksDir, directory), directory))
const findings = deriveFindings(tasks)
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

const html = readFileSync(distHtml, 'utf8')
const payload = '<script>window.__DASHBOARD_DATA__ = ' + JSON.stringify(data).replace(/</gu, '\\u003c') + ';</script>'
const injected = html.replace('</head>', payload + '</head>')
if (injected === html) {
  console.error('dashboard: could not inject data (no </head> in the built page)')
  process.exit(1)
}
const outputDir = join(runDir, 'dashboard')
mkdirSync(outputDir, { recursive: true })
writeFileSync(join(outputDir, 'index.html'), injected)
console.log(
  JSON.stringify(
    {
      dashboard: join(outputDir, 'index.html'),
      bytes: statSync(join(outputDir, 'index.html')).size,
      tasks: tasks.length,
      findings: findings.length,
    },
    null,
    2,
  ),
)

/**
 * Read one task's artifacts into the dashboard data contract.
 * @param taskDir - absolute task artifact directory.
 * @param directory - directory name (index-prefixed task id).
 * @returns task data, tolerating missing optional artifacts.
 */
function buildTask(taskDir, directory) {
  const id = directory.replace(/^\d+-/u, '')
  const taskInfo = readOptionalJson(join(taskDir, 'task.json'))
  const metrics = readOptionalJson(join(taskDir, 'metrics.json'))
  const checks = readOptionalJson(join(taskDir, 'checks.json'))
  const events = readOptionalEvents(join(taskDir, 'events.jsonl'))
  return {
    id,
    // Display status derives from the orthogonal semantics; raw fields stay in
    // the data contract so the UI can explain why a task is ungraded.
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

/**
 * Fallback isolation check for runs whose report predates the field: scan
 * normalized events for user-home path shapes (never personal exact paths).
 * @param tasks - task data with normalized events.
 * @returns clean flag plus the offending rows.
 */
function computeIsolation(tasks) {
  const pattern = /[A-Za-z]:\\Users\\|\/Users\/|\/home\//u
  const homeDirLeaks = []
  for (const task of tasks) {
    for (const event of task.events) {
      const summary = typeof event.summary === 'string' ? event.summary : ''
      if (pattern.test(summary)) {
        homeDirLeaks.push({ task: task.id, seq: event.seq, type: event.type })
      }
    }
  }
  return { clean: homeDirLeaks.length === 0, homeDirLeaks }
}

/**
 * Derive run-level findings from the trace events. Every finding points at the
 * exact tool failures that produced it; grouping is the only inference, and the
 * attribution layer comes from the shared classifier.
 * @param tasks - task data with normalized events.
 * @returns grouped findings with layer, confidence, and note.
 */
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
      confidence: 'confirmed',
    }))
}

/**
 * Normalize a failure message into a stable label (strip machine-specific paths).
 * @param text - raw failure text.
 * @returns a short label suitable for grouping and display.
 */
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
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf8'))
}

function readOptionalEvents(path) {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line))
}

function parseArgs(argv) {
  const parsed = {}
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    parsed[token.slice(2)] = argv[index + 1]
    index += 1
  }
  return parsed
}
