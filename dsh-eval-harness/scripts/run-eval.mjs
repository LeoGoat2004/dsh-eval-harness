// Development entry point for one real evaluation run. This is a thin CLI over
// the built plugin modules; the same modules will later back the plugin tools.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { runEvaluation, readDshVersion } from '../packages/dsh-eval-harness/lib/run/runner.js'
import { resolveModelTarget } from '../packages/dsh-eval-harness/lib/model/target.js'
import { resolveCredential } from '../packages/dsh-eval-harness/lib/model/credentials.js'

const args = parseArgs(process.argv.slice(2))
const requireArg = (name, value) => {
  if (value === undefined || value === '') {
    console.error('run-eval: missing required --' + name)
    process.exit(2)
  }
  return value
}

const workspaceRoot = resolve(import.meta.dirname, '..')
const benchmarkRoot = resolve(requireArg('benchmark-root', args['benchmark-root']))
const taskIds = requireArg('tasks', args.tasks)
  .split(',')
  .map((value) => value.trim())
  .filter((value) => value !== '')
const language = requireArg('language', args.language)
const timeoutMs = Number(args.timeout ?? '600000')
const maxSteps = Number(requireArg('max-steps', args['max-steps']))
const maxIdenticalToolCalls = Number(
  requireArg('max-identical-tool-calls', args['max-identical-tool-calls']),
)
const guard = { maxSteps, maxIdenticalToolCalls }
const permissionMode = requireArg('permission-mode', args['permission-mode'])
if (permissionMode !== 'workspace-write' && permissionMode !== 'danger-full-access') {
  console.error('run-eval: --permission-mode must be workspace-write or danger-full-access')
  process.exit(2)
}
const harnessMode = requireArg('harness-mode', args['harness-mode'])
if (harnessMode !== 'profile-snapshot' && harnessMode !== 'minimal-control') {
  console.error('run-eval: --harness-mode must be profile-snapshot or minimal-control')
  process.exit(2)
}
const outputDir = resolve(args.out ?? join(workspaceRoot, '..', 'runs'))
const dshBin = resolve(args['dsh-bin'] ?? join(workspaceRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
const profileName = args.profile ?? 'eval-m1'
const manifestPath = resolve(requireArg('manifest', args.manifest))

const harnessProfileArg = requireArg('harness-profile', args['harness-profile'])
const harnessProfile = existsSync(harnessProfileArg)
  ? resolve(harnessProfileArg)
  : join(homedir(), '.dsh', 'profiles', harnessProfileArg)
const provider = requireArg('provider', args.provider)
const modelId = requireArg('model', args.model)

if (!existsSync(harnessProfile)) {
  console.error('run-eval: harness profile not found: ' + harnessProfile)
  process.exit(2)
}
if (!existsSync(manifestPath)) {
  console.error('run-eval: manifest not found: ' + manifestPath)
  process.exit(2)
}
if (!existsSync(benchmarkRoot)) {
  console.error('run-eval: benchmark root not found: ' + benchmarkRoot)
  process.exit(2)
}
if (!existsSync(dshBin)) {
  console.error('run-eval: dsh launcher not found: ' + dshBin)
  process.exit(2)
}

const revision = resolveRevision(benchmarkRoot)
const target = resolveModelTarget(harnessProfile, provider, modelId)
const credential = resolveCredential(target.apiKeyEnv)
if (credential === null) {
  console.error(
    'run-eval: model credential ' + target.apiKeyEnv + ' not found in the environment or the DSH credential store',
  )
  process.exit(2)
}

const childEnv = { ...process.env }
for (const key of Object.keys(childEnv)) {
  if (key.startsWith('DSH_')) delete childEnv[key]
}
childEnv[target.apiKeyEnv] = credential
childEnv.DSH_PERMISSION_MODE = permissionMode

const summary = await runEvaluation({
  benchmarkRoot,
  benchmarkRevision: revision,
  manifestPath,
  language,
  taskIds,
  dshBin,
  dshVersion: readDshVersion(dshBin),
  outputDir,
  profileName,
  timeoutMs,
  permissionMode,
  harnessMode,
  harnessProfileDir: harnessProfile,
  env: childEnv,
  model: target,
  guard,
})

// Build the shareable report artifact when the dashboard app has been built.
// A dashboard failure must not invalidate a completed run.
if (args['no-dashboard'] === undefined) {
  const appDist = join(workspaceRoot, 'dashboard', 'dist', 'index.html')
  if (existsSync(appDist)) {
    const generated = spawnSync(process.execPath, [join(workspaceRoot, 'scripts', 'dashboard.mjs'), '--run', summary.runDir], {
      stdio: 'inherit',
    })
    if (generated.status !== 0) {
      console.error('run-eval: dashboard generation failed; run artifacts are still valid')
    }
  } else {
    console.error('run-eval: dashboard app is not built; run `npm run dashboard:app` to enable it')
  }
}
console.log(JSON.stringify({ runId: summary.runId, runDir: summary.runDir, totals: summary.totals }, null, 2))

/**
 * Resolve the pinned benchmark revision.
 * @param root - benchmark checkout root.
 * @returns the git commit, or `unknown` outside a checkout.
 */
function resolveRevision(root) {
  const result = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : 'unknown'
}

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
