// Mount-contract check: mount the built plugin on a real Cordis Context with a
// minimal fake `tools` service, and prove `apply()` actually registers the
// expected tool. This covers the wiring that the factory-only check misses.
import { Context, Service } from '@deepseek-ai/cordis'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { BUNDLE_DIR, ROWS } from './registry.mjs'

const entry = join(BUNDLE_DIR, 'lib', 'index.js')
if (!existsSync(entry)) {
  console.error('diag-mount: ' + entry + ' is missing; run `npm run build` first')
  process.exit(1)
}

class FakeTools extends Service {
  constructor(ctx) {
    super(ctx, 'tools')
    this.registered = []
  }

  register(definition) {
    this.registered.push(definition)
    return () => {}
  }
}

const ctx = new Context()
ctx.plugin(FakeTools)
await new Promise((resolve) => setTimeout(resolve, 50))

if (ctx.tools === undefined) {
  console.error('diag-mount: fake tools service did not register on the context')
  process.exit(1)
}

const module = await import(pathToFileURL(entry).href)
const plugin = module.default ?? module
ctx.plugin(plugin, { outputRoot: '', dshBin: '' })
await new Promise((resolve) => setTimeout(resolve, 50))

const names = ctx.tools.registered.map((definition) => definition.name)
const expectedNames = new Set(ROWS.map((row) => row.plugin))
const failures = []

// Hermetic fixture: the mount contract must not depend on the host having a
// benchmark checkout, Python or Docker. It only requires Node itself.
const fixtureRoot = mkdtempSync(join(tmpdir(), 'dsh-eval-mount-'))
const fixtureManifest = join(fixtureRoot, 'manifest.yml')
writeFileSync(
  fixtureManifest,
  [
    'schema: 1',
    'name: mount-fixture',
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
    '      reason: hermetic self-check needs Node',
    '    - id: node-eval',
    '      command: node',
    '      args: [-e, "process.exit(0)"]',
    '      reason: second requirement keeps the probe list real',
    '',
  ].join('\n'),
)
if (!expectedNames.has(plugin.name)) failures.push('plugin name is not a registered row plugin')
for (const tool of ['eval_status', 'eval_preflight', 'eval_manifest', 'eval_run']) {
  if (!names.includes(tool)) failures.push('apply() did not register ' + tool)
}

// Exercise the tool body too: registration alone does not prove `execute()` works.
const definition = ctx.tools.registered.find((candidate) => candidate.name === 'eval_status')
if (definition !== undefined) {
  const value = await definition.execute({}, {})
  if (value === null || typeof value !== 'object') {
    failures.push('eval_status execute() must return an object')
  } else if (value.plugin !== 'dsh-eval-harness') {
    failures.push('eval_status execute() returned the wrong plugin identity')
  } else if (value.config === null || typeof value.config !== 'object') {
    failures.push('eval_status execute() must report the effective config')
  } else if (!Array.isArray(value.jobs)) {
    failures.push('eval_status execute() must report the tracked jobs array')
  }
}

const manifestTool = ctx.tools.registered.find((candidate) => candidate.name === 'eval_manifest')
if (manifestTool === undefined) {
  failures.push('eval_manifest definition is missing')
} else {
  const value = await manifestTool.execute({ manifestPath: fixtureManifest, language: 'node' }, {})
  if (value?.valid !== true) failures.push('eval_manifest must validate a manifest')
  if ((value?.requirements ?? []).length === 0) failures.push('eval_manifest must report environment requirements')
  let rejected = false
  try {
    await manifestTool.execute(
      { manifestPath: join(tmpdir(), 'dsh-eval-missing-' + String(Date.now()) + '.yml'), language: 'python' },
      {},
    )
  } catch {
    rejected = true
  }
  if (!rejected) failures.push('eval_manifest must reject a missing manifest file')
}

const runTool = ctx.tools.registered.find((candidate) => candidate.name === 'eval_run')
if (runTool === undefined) {
  failures.push('eval_run definition is missing')
} else {
  let refused = false
  try {
    await runTool.execute(
      {
        harnessProfile: 'missing-profile',
        dshVersion: 'self-check',
        provider: 'siliconflow',
        model: 'Qwen/Qwen3-8B',
        manifestPath: fixtureManifest,
        language: 'node',
        revision: 'self-check',
        tasks: ['fixture-task'],
        benchmarkRoot: '.',
        timeoutMs: 1000,
        maxSteps: 10,
        maxIdenticalToolCalls: 2,
        permissionMode: 'workspace-write',
      },
      {},
    )
  } catch {
    refused = true
  }
  if (!refused) failures.push('eval_run must refuse when the plugin config has no dshBin')
}

const preflight = ctx.tools.registered.find((candidate) => candidate.name === 'eval_preflight')
if (preflight === undefined) {
  failures.push('eval_preflight definition is missing')
} else {
  // A temporary profile supplies the provider config the tool resolves from.
  const profileDir = mkdtempSync(join(tmpdir(), 'dsh-eval-profile-'))
  writeFileSync(
    join(profileDir, 'cordis.patch.yml'),
    [
      '- id: llm-pi-ai',
      "  name: '@deepseek-ai/dsh-llm-pi-ai'",
      '  config:',
      '    providers:',
      '      siliconflow:',
      '        apiKeyEnv: SILICONFLOW_API_KEY',
      '        api: openai-completions',
      '        baseURL: https://example.invalid/v1',
      '        models:',
      '          - id: Qwen/Qwen3-8B',
      '',
    ].join('\n'),
  )
  process.env.SILICONFLOW_API_KEY = 'self-check'
  const planArgs = {
    harnessProfile: profileDir,
    dshVersion: 'self-check',
    provider: 'siliconflow',
    model: 'Qwen/Qwen3-8B',
    manifestPath: fixtureManifest,
    language: 'node',
    revision: 'self-check',
    tasks: ['fixture-task'],
    harnessMode: 'minimal-control',
  }
  try {
    const value = await preflight.execute(planArgs, {})
    if (value?.ready !== true) failures.push('eval_preflight must report ready=true with the stub credential')
    if (value?.plan?.model?.provider !== 'siliconflow') {
      failures.push('eval_preflight must resolve the provider from the profile')
    }
    if (value?.plan?.model?.model !== 'Qwen/Qwen3-8B') {
      failures.push('eval_preflight must resolve the model from the profile')
    }
    if (!Array.isArray(value?.requirements) || value.requirements.length < 2) {
      failures.push('eval_preflight must report the declared fixture requirements')
    }
    if (!Array.isArray(value?.missing) || value.missing.length !== 0) {
      failures.push('eval_preflight must report no missing requirements on this host')
    }
    if (value?.plan?.benchmark?.tasks?.length !== 1) {
      failures.push('eval_preflight must echo the explicit task list in the plan')
    }
    if (value?.harnessAudit?.clean !== true) {
      failures.push('eval_preflight must report a clean harness audit for an isolated profile fixture')
    }
    if (!Array.isArray(value?.harnessAudit?.checks) || value.harnessAudit.checks.length === 0) {
      failures.push('eval_preflight must report harness audit checks')
    }
    let rejectedBenchmark = false
    try {
      await preflight.execute({ ...planArgs, manifestPath: join(tmpdir(), 'dsh-eval-missing-manifest.yml') }, {})
    } catch {
      rejectedBenchmark = true
    }
    if (!rejectedBenchmark) failures.push('eval_preflight must reject a missing manifest')
    let rejectedProvider = false
    try {
      await preflight.execute({ ...planArgs, provider: 'missing-provider' }, {})
    } catch {
      rejectedProvider = true
    }
    if (!rejectedProvider) failures.push('eval_preflight must reject providers absent from the profile')
  } finally {
    delete process.env.SILICONFLOW_API_KEY
    rmSync(profileDir, { recursive: true, force: true })
  }
}

if (failures.length > 0) {
  rmSync(fixtureRoot, { recursive: true, force: true })
  console.error('MOUNT CONTRACT FAIL')
  for (const failure of failures) console.error('  - ' + failure)
  process.exit(1)
}
rmSync(fixtureRoot, { recursive: true, force: true })
console.log('MOUNT CONTRACT OK (' + names.join(', ') + ')')
