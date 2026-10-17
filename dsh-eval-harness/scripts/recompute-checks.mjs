// Re-run the benchmark verifier for an existing run without spending API.
//
// Useful after a verifier/parser fix: it re-executes pytest against the stored
// workspace and rewrites checks.json, leaving traces untouched.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { builtinManifestPath, loadManifest } from '../packages/dsh-eval-harness/lib/benchmark/manifest.js'
import { loadBenchmarkFromManifest } from '../packages/dsh-eval-harness/lib/benchmark/interpreter.js'
import { runManifestVerifier } from '../packages/dsh-eval-harness/lib/run/verify.js'

const args = parseArgs(process.argv.slice(2))
if (args.run === undefined) {
  console.error('recompute-checks: --run <run-dir> is required')
  process.exit(2)
}
const workspaceRoot = resolve(import.meta.dirname, '..')
const runDir = resolve(args.run)
const run = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8'))
const benchmarkRoot = resolve(
  args['benchmark-root'] ?? join(workspaceRoot, '..', 'benchmarks', 'aider-polyglot'),
)
const manifestPath = args.manifest ?? run.manifestPath ?? builtinManifestPath('aider-polyglot')
const loaded = loadManifest(manifestPath)
const benchmark = await loadBenchmarkFromManifest(
  loaded,
  benchmarkRoot,
  run.language,
  run.tasks,
  run.benchmarkRevision,
)

const tasksDir = join(runDir, 'tasks')
const taskDirs = readdirSync(tasksDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()

let updated = 0
for (const directory of taskDirs) {
  const taskDir = join(tasksDir, directory)
  const workspaceDir = join(taskDir, 'workspace')
  const taskInfo = benchmark.tasks.find((task) => directory.endsWith('-' + task.id))
  if (taskInfo === undefined) {
    console.error('recompute-checks: no benchmark task for ' + directory)
    continue
  }
  if (!existsSync(workspaceDir)) {
    console.error('recompute-checks: workspace missing for ' + directory)
    continue
  }
  const verify = runManifestVerifier({ manifest: loaded.manifest, task: taskInfo, workspaceDir, taskDir, timeoutMs: 120_000 })
  writeFileSync(join(taskDir, 'checks.json'), JSON.stringify(verify, null, 2) + '\n')
  updated += 1
  console.log(
    JSON.stringify({ task: taskInfo.id, ok: verify.ok, passed: verify.passed, total: verify.total }),
  )
}
console.log(JSON.stringify({ run: runDir, updated }))

/**
 * Parse `--key value` and `--flag` arguments.
 * @param argv - arguments after the script path.
 * @returns a map of flag names to values.
 */
function parseArgs(argv) {
  const parsed = {}
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const name = token.slice(2)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) {
      parsed[name] = 'true'
      continue
    }
    parsed[name] = next
    index += 1
  }
  return parsed
}
