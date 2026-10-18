// Integration self-check (external benchmark required).
//
// Proves the manifest interpreter materializes a real benchmark task and that
// red/green validation holds: a stub workspace fails and the official
// reference solution passes. Not part of `npm test` because it needs a local
// benchmark checkout and Python/pytest.
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { builtinManifestPath, loadManifest } from '../packages/dsh-eval-harness/lib/benchmark/manifest.js'
import { loadBenchmarkFromManifest } from '../packages/dsh-eval-harness/lib/benchmark/interpreter.js'
import { validateManifest } from '../packages/dsh-eval-harness/lib/benchmark/validate.js'

const root = resolve(import.meta.dirname, '..')
const benchmarkRoot = resolve(process.argv[2] ?? join(root, '..', 'benchmarks', 'aider-polyglot'))
if (!existsSync(benchmarkRoot)) {
  console.log('INTEGRATION SKIP: benchmark checkout not found at ' + benchmarkRoot)
  process.exit(0)
}

const failures = []
const check = (condition, message) => {
  if (!condition) failures.push(message)
}

const preset = loadManifest(builtinManifestPath('aider-polyglot'))
const loadedBenchmark = await loadBenchmarkFromManifest(preset, benchmarkRoot, 'python', ['transpose'], 'self-check')
const task = loadedBenchmark.tasks[0]
check(loadedBenchmark.name === 'aider-polyglot', 'interpreter must carry the manifest name')
check(task?.id === 'transpose', 'interpreter must materialize the requested task id')
check(task?.solutionFiles.includes('transpose.py') === true, 'interpreter must read solution files from task meta')
check(task?.testFiles.length >= 1, 'interpreter must read test files from task meta')
check(task?.exclude.includes(task.testFiles[0]) === true, 'test files must be excluded from the agent workspace')
check((task?.prompt.length ?? 0) > 100, 'interpreter must assemble a non-trivial prompt')

const redGreen = await validateManifest({
  loaded: preset,
  root: benchmarkRoot,
  language: 'python',
  taskIds: ['transpose'],
  timeoutMs: 120_000,
})
check(redGreen.ok === true, 'red/green validation must pass for the built-in preset')
check(
  redGreen.results.every((result) => result.redOk && result.greenOk),
  'red must fail on the stub and green must pass with the reference solution',
)

if (failures.length > 0) {
  console.error('INTEGRATION FAIL')
  for (const failure of failures) console.error('  - ' + failure)
  process.exit(1)
}
console.log('INTEGRATION OK (interpreter, red/green)')
