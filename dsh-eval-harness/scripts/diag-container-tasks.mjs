// Container-task red/green probe (developer diagnostic).
//
// Validates that a container-based benchmark task can really be graded outside
// the plugin's own runner: build the task image, run the task's tests without a
// solution (must fail) and with the official solution (must pass). It never runs
// a model and never edits benchmark data; logs go next to the tasks checkout.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const args = parseArgs(process.argv.slice(2))
if (args['tasks-dir'] === undefined || args.tasks === undefined) {
  console.error('usage: node scripts/diag-container-tasks.mjs --tasks-dir <dir> --tasks id1,id2 [--timeout-ms 900000]')
  process.exit(2)
}
const tasksDir = resolve(args['tasks-dir'])
const taskIds = args.tasks.split(',').map((value) => value.trim()).filter((value) => value !== '')
const timeoutMs = Number(args['timeout-ms'] ?? '900000')
const proxy = args.proxy
const outDir = resolve(args.out ?? join(dirname(tasksDir), '.container-validation'))
mkdirSync(outDir, { recursive: true })

const results = []
for (const task of taskIds) {
  const taskDir = join(tasksDir, task)
  const missing = ['Dockerfile', 'run-tests.sh', 'solution.sh', 'tests'].filter(
    (name) => !existsSync(join(taskDir, name)),
  )
  if (missing.length > 0) {
    results.push({ task, error: 'missing container-task files: ' + missing.join(', ') })
    continue
  }
  const image = 'dsh-eval-container-probe:' + task.toLowerCase().replace(/[^a-z0-9_.-]/gu, '-')
  const proxyBuildArgs =
    proxy === undefined
      ? []
      : [
          '--build-arg', 'HTTP_PROXY=' + proxy,
          '--build-arg', 'HTTPS_PROXY=' + proxy,
          '--build-arg', 'http_proxy=' + proxy,
          '--build-arg', 'https_proxy=' + proxy,
        ]
  const proxyRunEnv =
    proxy === undefined
      ? []
      : [
          '-e', 'HTTP_PROXY=' + proxy,
          '-e', 'HTTPS_PROXY=' + proxy,
          '-e', 'http_proxy=' + proxy,
          '-e', 'https_proxy=' + proxy,
        ]
  const buildNetwork = args['build-network'] ?? 'host'
  const startedBuild = Date.now()
  const build = run('docker', [
    'build',
    ...(proxy === undefined ? [] : ['--network', buildNetwork]),
    ...proxyBuildArgs,
    '-t',
    image,
    taskDir,
  ])
  const buildMs = Date.now() - startedBuild
  if (build.status !== 0) {
    writeLog(outDir, task + '.build.log', build)
    results.push({ task, built: false, buildMs, error: 'docker build failed' })
    continue
  }
  const mounts = [
    '-v', taskDir + ':/tbench:ro',
    '-v', join(taskDir, 'tests') + ':/tests:ro',
    '-e', 'TEST_DIR=/tests',
    ...proxyRunEnv,
  ]
  const startedRed = Date.now()
  const red = run('docker', ['run', '--rm', ...mounts, image, 'bash', '-lc', 'cd /app && bash /tbench/run-tests.sh'])
  const redMs = Date.now() - startedRed
  const startedGreen = Date.now()
  const green = run('docker', [
    'run', '--rm', ...mounts, image,
    'bash', '-lc', 'cd /app && bash /tbench/solution.sh && bash /tbench/run-tests.sh',
  ])
  const greenMs = Date.now() - startedGreen
  writeLog(outDir, task + '.red.log', red)
  writeLog(outDir, task + '.green.log', green)
  results.push({
    task,
    built: true,
    buildMs,
    redOk: red.status !== 0,
    redMs,
    greenOk: green.status === 0,
    greenMs,
    redExit: red.status,
    greenExit: green.status,
  })
  console.log(JSON.stringify(results[results.length - 1]))
}
console.log(JSON.stringify({ tasksDir, outDir, results }, null, 2))
process.exit(results.every((result) => result.built === true && result.redOk === true && result.greenOk === true) ? 0 : 1)

/**
 * Run one command and capture its tail output.
 * @param command - executable name.
 * @param args - executable arguments.
 * @returns exit status and combined output.
 */
function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true })
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error === undefined ? undefined : String(result.error),
  }
}

function writeLog(dir, name, result) {
  writeFileSync(
    join(dir, name),
    'exit=' + String(result.status) + '\n' + (result.error ?? '') + result.stdout + result.stderr,
  )
}

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
