// Pipeline self-check without model calls.
//
// Runs the real evaluation pipeline with a stub `dsh` launcher that exits
// immediately, so preflight, environment recording, artifact layout and the
// failure path are exercised end to end without spending API. Also proves the
// preflight refuses to start when the model credential is missing.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { readDshVersion, runEvaluation } from '../packages/dsh-eval-harness/lib/run/runner.js'
import { createLoopGuard } from '../packages/dsh-eval-harness/lib/run/guard.js'
import { parseJunit } from '../packages/dsh-eval-harness/lib/run/verify.js'
import {
  builtinManifestPath,
  loadManifest,
  manifestRequirements,
  manifestTaskRoot,
  renderTemplate,
} from '../packages/dsh-eval-harness/lib/benchmark/manifest.js'
import { loadBenchmarkFromManifest } from '../packages/dsh-eval-harness/lib/benchmark/interpreter.js'

const root = resolve(import.meta.dirname, '..')
const realDsh = join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const workDir = mkdtempSync(join(tmpdir(), 'dsh-eval-pipeline-'))
const stubLauncher = join(workDir, 'stub-dsh.mjs')
writeFileSync(stubLauncher, 'process.exit(7)\n')

// Hermetic benchmark fixture: the default self-check must not need a local
// benchmark checkout, Python or Docker. Only Node is required.
const benchRoot = join(workDir, 'bench')
const fixtureTaskDir = join(benchRoot, 'node', 'task-1')
mkdirSync(fixtureTaskDir, { recursive: true })
writeFileSync(join(fixtureTaskDir, 'prompt.md'), 'write a file')
const hermeticManifest = join(workDir, 'manifest.yml')
writeFileSync(
  hermeticManifest,
  [
    'schema: 1',
    'name: pipeline-fixture',
    'tasks:',
    '  discovery: directory',
    '  root: "{{language}}"',
    '  exclude: []',
    'prompt:',
    '  files:',
    '    - path: prompt.md',
    '  template: "{{prompt}}"',
    'verify:',
    '  command: [node, -e, "process.exit(0)"]',
    '  result: junitxml',
    'environment:',
    '  requirements:',
    '    - id: node',
    '      command: node',
    '      args: [--version]',
    '      reason: hermetic pipeline self-check needs Node',
    '',
  ].join('\n'),
)

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
    benchmarkRoot: benchRoot,
    benchmarkRevision: 'pipeline-self-check',
    language: 'node',
    taskIds: ['task-1'],
    dshBin: stubLauncher,
    manifestPath: hermeticManifest,
    harnessMode: 'minimal-control',
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
check(
  summary.tasks[0]?.executionStatus === 'agent_crashed',
  'stub launcher must produce an agent_crashed execution status',
)
check(summary.tasks[0]?.taskOutcome === 'ungraded', 'crashed episodes must not claim a benchmark outcome')

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
    'fixture requirements must pass in this environment',
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

// The manifest is the declarative benchmark contract: validate the shipped
// preset, its template rendering, and that a malformed manifest is rejected.
const preset = loadManifest(builtinManifestPath('aider-polyglot'))
check(preset.manifest.name === 'aider-polyglot', 'preset manifest name must load')
check(
  manifestTaskRoot(preset.manifest, 'python') === 'python/exercises/practice',
  'manifest task root must substitute {{language}}',
)
check(
  manifestRequirements(preset.manifest).length === 2,
  'manifest must declare its environment requirements',
)
check(
  renderTemplate('x {{a}} y', { a: 'A' }) === 'x A y' && renderTemplate('{{missing}}', {}) === '{{missing}}',
  'manifest template rendering must substitute known keys only',
)
const brokenManifest = join(workDir, 'broken-manifest.yml')
writeFileSync(brokenManifest, 'schema: 2\nname: broken\n')
let manifestRejected = false
try {
  loadManifest(brokenManifest)
} catch {
  manifestRejected = true
}
check(manifestRejected, 'manifest loader must reject an unsupported schema')

// Red/green and real-benchmark interpretation live in the integration script
// (`npm run test:integration`) because they need an external checkout.

// Optional container-execution check (opt-in: needs Docker + network for the
// fixture image). The executor is benchmark-agnostic: the fixture manifest only
// declares image, mounts, an agent command and a grading command.
if (process.env.DSH_EVAL_DOCKER_TESTS === '1') {
  const { dockerRuntimeCheck, containerImageCheck, runContainerEpisode } = await import(
    '../packages/dsh-eval-harness/lib/run/container.js'
  )
  const docker = dockerRuntimeCheck()
  check(docker.ok === true, 'container executor test: ' + docker.detail)
  if (docker.ok) {
    const fixtureDir = join(workDir, 'container-fixture')
    const image = 'dsh-eval-fixture:py'
    mkdirSync(fixtureDir, { recursive: true })
    writeFileSync(
      join(fixtureDir, 'Dockerfile'),
      'FROM python:3.11-slim\nRUN pip install --no-cache-dir -i ' +
        (process.env.DSH_EVAL_PIP_INDEX ?? 'https://pypi.tuna.tsinghua.edu.cn/simple') +
        ' pytest\n',
    )
    const built = spawnSync('docker', ['build', '--network', 'host', '-t', image, fixtureDir], {
      encoding: 'utf8',
      timeout: 600_000,
      windowsHide: true,
    })
    check(built.status === 0, 'container executor test: fixture image build failed: ' + String(built.stderr).slice(-300))
    const imageCheck = containerImageCheck(image)
    check(imageCheck.ok === true, 'container executor test: ' + imageCheck.detail)
    const fixtureTaskDir = join(fixtureDir, 'python', 'fixture-task')
    mkdirSync(join(fixtureTaskDir, '.meta'), { recursive: true })
    mkdirSync(join(fixtureTaskDir, 'tests'), { recursive: true })
    writeFileSync(join(fixtureTaskDir, 'prompt.md'), 'write out.py')
    writeFileSync(join(fixtureTaskDir, 'out.py'), '# stub\n')
    writeFileSync(join(fixtureTaskDir, '.meta', 'config.json'), '{"files":{"solution":["out.py"],"test":["test_out.py"]}}')
    writeFileSync(join(fixtureTaskDir, 'tests', 'test_out.py'), 'def test_out():\n    assert open("/workspace/out.py").read().strip() == "ok"\n')
    const manifestPath = join(workDir, 'container-manifest.yml')
    writeFileSync(
      manifestPath,
      [
        'schema: 1',
        'name: fixture-container',
        'tasks:',
        '  discovery: directory',
        '  root: "{{language}}"',
        '  meta:',
        '    file: .meta/config.json',
        '    solutionFiles: files.solution',
        '    testFiles: files.test',
        '  exclude: [.meta]',
        'prompt:',
        '  files:',
        '    - path: prompt.md',
        '  template: "{{prompt}} {{solutionFiles}}"',
        'verify:',
        '  command: [python, -m, pytest, "{{testFiles}}"]',
        '  result: junitxml',
        'environment:',
        '  requirements:',
        '    - id: docker',
        '      kind: container-runtime',
        '      command: docker',
        '      args: [--version]',
        '      reason: container execution needs a container runtime',
        'execution:',
        '  kind: container',
        '  container:',
        '    image: "' + image + '"',
        '    workspace: /workspace',
        '    mounts:',
        '      - source: "{{taskDir}}"',
        '        target: /task',
        '        readOnly: true',
        '    agentCommand: [bash, -lc, "echo ok > /workspace/out.py"]',
        '    verifyCommand: [python, -m, pytest, /task/tests/test_out.py, --junitxml=/dsh-verify/junit.xml, -q]',
        '',
      ].join('\n'),
    )
    const loadedFixture = loadManifest(manifestPath)
    const benchmarkFixture = await loadBenchmarkFromManifest(loadedFixture, fixtureDir, 'python', ['fixture-task'], 'self-check')
    const fixtureTask = benchmarkFixture.tasks[0]
    const episodeDir = join(workDir, 'container-episode')
    mkdirSync(episodeDir, { recursive: true })
    writeFileSync(join(episodeDir, 'prompt.md'), 'write out.py')
    const result = await runContainerEpisode({
      manifest: loadedFixture.manifest,
      task: fixtureTask,
      taskDir: join(episodeDir, 'task-artifacts'),
      taskSourceDir: fixtureTask.exerciseDir,
      workspaceDir: join(episodeDir, 'workspace'),
      traceDir: join(episodeDir, 'trace'),
      verifyDir: join(episodeDir, 'verify'),
      promptFile: episodeDir + '/prompt.md',
      timeoutMs: 120_000,
      guard: { maxSteps: 50, maxIdenticalToolCalls: 3 },
      logPath: join(episodeDir, 'container.log'),
    })
    check(result.verify.ok === true, 'container executor must grade a successful container episode: ' + JSON.stringify(result.verify.error ?? ''))
    check(result.agentExit === 0, 'container executor must report the agent exit marker')
    check(result.verifyExit === 0, 'container executor must report the grading exit marker')
    check(
      result.graderVisibility.exposedToAgent.length === 0,
      'default mounts must keep the grader invisible to the agent: ' +
        JSON.stringify(result.graderVisibility.exposedToAgent),
    )
    check(
      result.graderVisibility.verifierOnlyMounts.includes('/task'),
      'verifier-only mounts must include the benchmark task directory',
    )
    check(result.graderVisibility.sharedImage === true, 'the default single image must be recorded as shared')

    // Regression: the wrapper shell used to swallow the agent's real status.
    // A non-zero agent command must never reach grading, and must be reported.
    const variant = async (name, agentCommand, options = {}) => {
      const dir = join(workDir, 'container-' + name)
      mkdirSync(dir, { recursive: true })
      const manifestPath = join(dir, 'manifest.yml')
      writeFileSync(
        manifestPath,
        [
          'schema: 1',
          'name: container-' + name,
          'tasks:',
          '  discovery: directory',
          '  root: "{{language}}"',
          '  exclude: []',
          'prompt:',
          '  files:',
          '    - path: prompt.md',
          '  template: "{{prompt}}"',
          'environment:',
          '  requirements:',
          '    - id: docker',
          '      kind: container-runtime',
          '      command: docker',
          '      args: [--version]',
          '      reason: container execution needs a container runtime',
          'execution:',
          '  kind: container',
          '  container:',
          '    image: "' + image + '"',
          '    workspace: /workspace',
          ...(options.agentSeesTask
            ? [
                '    agentMounts:',
                '      - source: "{{taskDir}}"',
                '        target: /task',
                '        readOnly: true',
              ]
            : []),
          '    mounts:',
          '      - source: "{{taskDir}}"',
          '        target: /task',
          '        readOnly: true',
          ...(options.verifyWorkspaceRw ? ['    verifyWorkspace: read-write'] : []),
          '    agentCommand: ' + JSON.stringify(agentCommand),
          '    verifyCommand: ' +
            JSON.stringify(
              options.verifyCommand ?? ['python', '-m', 'pytest', '/task/tests/test_out.py', '--junitxml=/dsh-verify/junit.xml', '-q'],
            ),
          '',
        ].join('\n'),
      )
      writeFileSync(join(dir, 'prompt.md'), 'write out.py')
      const loaded = loadManifest(manifestPath)
      return runContainerEpisode({
        manifest: loaded.manifest,
        task: fixtureTask,
        taskDir: join(dir, 'task-artifacts'),
        taskSourceDir: fixtureTask.exerciseDir,
        workspaceDir: join(dir, 'workspace'),
        traceDir: join(dir, 'trace'),
        verifyDir: join(dir, 'verify'),
        promptFile: join(dir, 'prompt.md'),
        timeoutMs: options.timeoutMs ?? 60_000,
        guard: options.guard ?? { maxSteps: 50, maxIdenticalToolCalls: 3 },
        logPath: join(dir, 'container.log'),
      })
    }

    const exit17 = await variant('exit17', ['bash', '-lc', 'exit 17'])
    check(exit17.agentExit === 17, 'agent exit 17 must be preserved as the agent exit')
    check(exit17.exitCode === 17, 'agent exit 17 must be reported as the episode exit code')
    check(exit17.verify.ok === false, 'a failed agent must not receive a passing grade')
    check(
      (exit17.verify.error ?? '').includes('skipped'),
      'grading must be skipped when the agent command fails',
    )
    check(!existsSync(join(workDir, 'container-exit17', 'verify', 'junit.xml')), 'failed agent must not run the verifier')

    const timedOut = await variant('timeout', ['bash', '-lc', 'sleep 10'], { timeoutMs: 700 })
    check(timedOut.timedOut === true, 'container episode must honour the timeout')
    check(timedOut.verify.ok === false, 'a timed-out agent must not receive a passing grade')

    const guarded = await variant(
      'guard',
      ['bash', '-lc', 'mkdir -p /trace/g && printf \'{"type":"step/start","step":2}\' > /trace/g/session.v4.jsonl && sleep 10'],
      { guard: { maxSteps: 1, maxIdenticalToolCalls: 10 }, timeoutMs: 20_000 },
    )
    check(guarded.guard !== null, 'container guard must trip on the mounted trace')
    check(guarded.verify.ok === false, 'a guard-stopped agent must not receive a passing grade')

    // The agent must not be able to read the benchmark's tests by default.
    const hiddenGrader = await variant(
      'grader-hidden',
      ['bash', '-lc', 'test -e /task/tests/test_out.py && exit 7 || true'],
    )
    check(hiddenGrader.agentExit === 0, 'agent must not see the verifier-only task directory')

    // If an adapter exposes the grader to the agent, the audit must catch it.
    const exposedGrader = await variant(
      'grader-exposed',
      ['bash', '-lc', 'test -e /task/tests/test_out.py && exit 7 || true'],
      { agentSeesTask: true },
    )
    check(exposedGrader.agentExit === 7, 'exposed grader is expected to be readable in this negative case')
    check(
      exposedGrader.graderVisibility.exposedToAgent.includes('/task'),
      'grader visibility audit must report the exposed verifier mount',
    )

    // A writable verifier must never rewrite the agent's evidence.
    const isolatedVerify = await variant(
      'verify-isolated',
      ['bash', '-lc', 'echo agent-wrote > /workspace/out.txt'],
      {
        verifyWorkspaceRw: true,
        verifyCommand: ['bash', '-lc', 'echo tampered > /workspace/tampered.txt'],
      },
    )
    const agentOut = join(workDir, 'container-verify-isolated', 'workspace')
    check(existsSync(join(agentOut, 'out.txt')), 'agent output must stay in the preserved workspace')
    check(!existsSync(join(agentOut, 'tampered.txt')), 'verifier must not write into the preserved workspace')
    check(
      existsSync(join(workDir, 'container-verify-isolated', 'verify', 'workspace-snapshot', 'tampered.txt')),
      'writable verifier must write into its disposable snapshot',
    )
    check(isolatedVerify.verify.ok === false, 'a verifier without a junit report is not a passing grade')
  }
}

// The credential check must refuse to start before any episode runs.
let refused = false
try {
  await runEvaluation({
    benchmarkRoot: benchRoot,
    benchmarkRevision: 'pipeline-self-check',
    language: 'node',
    taskIds: ['task-1'],
    dshBin: stubLauncher,
    manifestPath: hermeticManifest,
    harnessMode: 'minimal-control',
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


