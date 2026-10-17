// Pipeline self-check without model calls.
//
// Runs the real evaluation pipeline with a stub `dsh` launcher that exits
// immediately, so preflight, environment recording, artifact layout and the
// failure path are exercised end to end without spending API. Also proves the
// preflight refuses to start when the model credential is missing.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { readDshVersion, runEvaluation } from '../packages/dsh-eval-harness/lib/run/runner.js'
import { createLoopGuard } from '../packages/dsh-eval-harness/lib/run/guard.js'
import { parseJunit } from '../packages/dsh-eval-harness/lib/run/verify.js'

const root = resolve(import.meta.dirname, '..')
const benchmarkRoot = resolve(process.argv[2] ?? join(root, '..', 'benchmarks', 'aider-polyglot'))
const realDsh = join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const workDir = mkdtempSync(join(tmpdir(), 'dsh-eval-pipeline-'))
const stubLauncher = join(workDir, 'stub-dsh.mjs')
writeFileSync(stubLauncher, 'process.exit(7)\n')

const failures = []
const check = (condition, message) => {
  if (!condition) failures.push(message)
}

const modelTarget = {
  harnessProfile: 'pipeline-self-check',
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  api: undefined,
  baseURL: undefined,
  apiKeyEnv: 'DEEPSEEK_API_KEY',
  listed: true,
}
const guard = { maxSteps: 200, maxIdenticalToolCalls: 5 }

let summary
try {
  summary = await runEvaluation({
    benchmarkRoot,
    benchmarkRevision: 'pipeline-self-check',
    language: 'python',
    taskIds: ['transpose'],
    dshBin: stubLauncher,
    dshVersion: readDshVersion(realDsh),
    outputDir: join(workDir, 'runs'),
    profileName: 'eval-pipeline-check',
    timeoutMs: 30_000,
    permissionMode: 'workspace-write',
    env: { ...process.env, DEEPSEEK_API_KEY: 'pipeline-self-check' },
    model: modelTarget,
    guard,
  })
} catch (error) {
  console.error('PIPELINE SELF-CHECK FAIL: runEvaluation threw: ' + String(error))
  rmSync(workDir, { recursive: true, force: true })
  process.exit(1)
}

const preflightPath = join(summary.runDir, 'preflight.json')
const runPath = join(summary.runDir, 'run.json')
const reportPath = join(summary.runDir, 'report.json')
check(existsSync(preflightPath), 'preflight.json is missing')
check(existsSync(runPath), 'run.json is missing')
check(existsSync(reportPath), 'report.json is missing')
check(summary.tasks.length === 1, 'expected exactly one task result')
check(summary.tasks[0]?.status === 'error', 'stub launcher must produce an errored task')

if (existsSync(preflightPath) && existsSync(runPath)) {
  const preflight = JSON.parse(readFileSync(preflightPath, 'utf8'))
  const run = JSON.parse(readFileSync(runPath, 'utf8'))
  check(preflight.ok === true, 'preflight must pass with a stub launcher and a dummy credential')
  check(preflight.environment?.backend === 'local', 'preflight must record the local backend')
  check(preflight.environment?.network?.policy !== undefined, 'preflight must record the network policy')
  check(
    Array.isArray(preflight.environment?.requirements) && preflight.environment.requirements.length >= 1,
    'preflight must record benchmark environment requirements',
  )
  check(
    (preflight.environment?.requirements ?? []).every((item) => item.ok === true),
    'python and pytest requirements must pass in this environment',
  )
  check(run.environment?.recorded === true, 'run.json must mark the environment as recorded')
  check(run.environment?.sandbox === 'workspace-write', 'run.json must record the sandbox mode')
  check(
    run.environment?.model?.provider === modelTarget.provider && run.environment?.model?.model === modelTarget.model,
    'run.json must record the confirmed model target',
  )
  check(
    run.model?.provider === modelTarget.provider && run.model?.apiKeyEnv === modelTarget.apiKeyEnv,
    'run.json must record the full model target including the credential env name',
  )
  const report = JSON.parse(readFileSync(reportPath, 'utf8'))
  check(
    report.modelVerification?.declared?.model === modelTarget.model,
    'report.json must declare the model used for verification',
  )
  check(
    report.isolation?.clean === true,
    'report.json must record the hermetic-prompt isolation result',
  )
  const profilePatchPath = join(
    summary.runDir,
    'dsh-home',
    'profiles',
    'eval-pipeline-check',
    'cordis.patch.yml',
  )
  const profilePatch = existsSync(profilePatchPath) ? readFileSync(profilePatchPath, 'utf8') : ''
  check(
    profilePatch.includes('- id: tool-skill') &&
      profilePatch.includes('- id: skill-filesystem') &&
      (profilePatch.match(/disabled: true/gu) ?? []).length >= 5,
    'eval profile must disable the skill loader, skill filesystem and other user-home rows',
  )
  check(
    profilePatch.includes('maxBytes: 0'),
    'eval profile must disable user/project instruction discovery',
  )
}

// The loop guard is a pure state machine; assert its trips without any process.
const guardUnit = createLoopGuard({ maxSteps: 3, maxIdenticalToolCalls: 2 })
check(guardUnit.observe({ type: 'tool/call', step: 1, data: { name: 'write', arguments: '{"a":1}' } }) === null, 'guard must not trip on a fresh call')
check(guardUnit.observe({ type: 'tool/call', step: 2, data: { name: 'write', arguments: '{"a":1}' } }) === null, 'guard must allow one repeat')
check(
  guardUnit.observe({ type: 'tool/call', step: 3, data: { name: 'write', arguments: '{"a":1}' } })?.reason.includes('identical tool call') === true,
  'guard must trip on repeated identical tool calls',
)
const stepGuard = createLoopGuard({ maxSteps: 2, maxIdenticalToolCalls: 10 })
check(stepGuard.observe({ type: 'step/start', step: 1 }) === null, 'guard must allow early steps')
check(
  stepGuard.observe({ type: 'step/start', step: 3 })?.reason.includes('max steps') === true,
  'guard must trip when the step bound is exceeded',
)

// The junit parser must keep test names distinct even though `classname` ends
// with the substring `name=`; a regression here collapses every check id.
const parsed = parseJunit(
  '<testsuite><testcase classname="m.TransposeTest" name="test_simple" /><testcase classname="m.TransposeTest" name="test_empty"><failure/></testcase></testsuite>',
)
check(
  parsed.length === 2 && parsed[0]?.id === 'm.TransposeTest::test_simple' && parsed[1]?.id === 'm.TransposeTest::test_empty',
  'junit parser must read the real name attribute instead of the classname suffix',
)
check(parsed[1]?.pass === false, 'junit parser must mark a failure element as failed')

// The credential check must refuse to start before any episode runs.
let refused = false
try {
  await runEvaluation({
    benchmarkRoot,
    benchmarkRevision: 'pipeline-self-check',
    language: 'python',
    taskIds: ['transpose'],
    dshBin: stubLauncher,
    dshVersion: readDshVersion(realDsh),
    outputDir: join(workDir, 'runs-refused'),
    profileName: 'eval-pipeline-check',
    timeoutMs: 30_000,
    permissionMode: 'workspace-write',
    env: { ...process.env, DEEPSEEK_API_KEY: '' },
    model: modelTarget,
    guard,
  })
} catch (error) {
  const message = String(error)
  refused = message.includes('model-credential') || message.includes('DEEPSEEK_API_KEY')
}
check(refused, 'a missing model credential must fail preflight before any episode')

rmSync(workDir, { recursive: true, force: true })
if (failures.length > 0) {
  console.error('PIPELINE SELF-CHECK FAIL')
  for (const failure of failures) console.error('  - ' + failure)
  process.exit(1)
}
console.log('PIPELINE SELF-CHECK OK (preflight, environment facts, artifacts, refusal path)')

