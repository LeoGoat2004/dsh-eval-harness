// Recompute fixed metrics for an existing run from its persisted traces.
// Metrics must always be derivable from the raw trace; this is the tool that
// proves it and refreshes a run after a collector fix without re-spending API.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { findSessionLog } from '../packages/dsh-eval-harness/lib/run/profile.js'
import { foldMetrics, normalizeEvents, readTrace } from '../packages/dsh-eval-harness/lib/run/collect.js'

const args = parseArgs(process.argv.slice(2))
if (args.run === undefined) {
  console.error('recompute-metrics: --run <run-dir> is required')
  process.exit(2)
}
const runDir = resolve(args.run)
const reportPath = join(runDir, 'report.json')
const report = JSON.parse(readFileSync(reportPath, 'utf8'))
const tasksDir = join(runDir, 'tasks')
const metricsById = new Map()

for (const entry of readdirSync(tasksDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const taskDir = join(tasksDir, entry.name)
  const id = entry.name.replace(/^\d+-/u, '')
  const sessionLog = findSessionLog(join(taskDir, 'trace'))
  if (sessionLog === null) continue
  const trace = readTrace(sessionLog)
  const metrics = foldMetrics(trace.events)
  writeFileSync(join(taskDir, 'metrics.json'), JSON.stringify(metrics, null, 2) + '\n')
  writeFileSync(join(taskDir, 'events.jsonl'), normalizeEvents(trace).join('\n') + '\n')
  metricsById.set(id, metrics)
}

let totalTokens = 0
let toolCalls = 0
for (const task of report.tasks) {
  const metrics = metricsById.get(task.id)
  if (metrics === undefined) continue
  task.metrics = metrics
  totalTokens += metrics.totalTokens
  toolCalls += metrics.toolCalls
}
report.totals.totalTokens = totalTokens
report.totals.toolCalls = toolCalls
writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
console.log(
  JSON.stringify({ run: runDir, tasks: metricsById.size, totalTokens, toolCalls }, null, 2),
)

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
