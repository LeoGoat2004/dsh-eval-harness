// Loader-contract check: import the built bundle, replicate Cordis
// `unwrapExports`, and prove the module exports the shape the loader needs plus
// a working tool factory. No host boot required.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { BUNDLE_DIR, ROWS } from './registry.mjs'

const failures = []
const check = (condition, message) => {
  if (!condition) failures.push(message)
}

const entry = join(BUNDLE_DIR, 'lib', 'index.js')
if (!existsSync(entry)) {
  console.error('diag-import: ' + entry + ' is missing; run `npm run build` first')
  process.exit(1)
}

const module = await import(pathToFileURL(entry).href)
const plugin = module.default ?? module
check(typeof plugin?.apply === 'function', 'bundle must expose apply()')
check(Array.isArray(plugin?.inject), 'bundle must declare inject[]')
check(module.Config !== undefined, 'bundle must export a Schemastery Config')

const expectedNames = new Set(ROWS.map((row) => row.plugin))
check(
  typeof plugin?.name === 'string' && expectedNames.has(plugin.name),
  'plugin name must be one of the registered row plugins',
)

const factory = module.createEvalStatusTool ?? plugin?.createEvalStatusTool
check(typeof factory === 'function', 'bundle must export createEvalStatusTool()')
if (typeof factory === 'function') {
  const tool = factory({ outputRoot: '' })
  check(typeof tool?.name === 'string' && tool.name.startsWith('eval_'), 'tool names must start with eval_')
  check(typeof tool?.execute === 'function', 'tool must expose execute()')
  check(typeof tool?.description === 'string' && tool.description.length > 0, 'tool needs a description')
}

const preflightFactory = module.createEvalPreflightTool ?? plugin?.createEvalPreflightTool
check(typeof preflightFactory === 'function', 'bundle must export createEvalPreflightTool()')
if (typeof preflightFactory === 'function') {
  const tool = preflightFactory()
  check(tool?.name === 'eval_preflight', 'preflight tool name must be eval_preflight')
  check(typeof tool?.execute === 'function', 'preflight tool must expose execute()')
  check(
    typeof tool?.description === 'string' && tool.description.includes('第 0 步'),
    'preflight description must state that it is the mandatory step 0',
  )
}

const manifestFactory = module.createEvalManifestTool ?? plugin?.createEvalManifestTool
check(typeof manifestFactory === 'function', 'bundle must export createEvalManifestTool()')
if (typeof manifestFactory === 'function') {
  const tool = manifestFactory()
  check(tool?.name === 'eval_manifest', 'manifest tool name must be eval_manifest')
  check(typeof tool?.execute === 'function', 'manifest tool must expose execute()')
}

const runFactory = module.createEvalRunTool ?? plugin?.createEvalRunTool
check(typeof runFactory === 'function', 'bundle must export createEvalRunTool()')
if (typeof runFactory === 'function') {
  const tool = runFactory({ outputRoot: '', dshBin: '' })
  check(tool?.name === 'eval_run', 'run tool name must be eval_run')
  check(typeof tool?.execute === 'function', 'run tool must expose execute()')
}

if (failures.length > 0) {
  console.error('IMPORT CONTRACT FAIL')
  for (const failure of failures) console.error('  - ' + failure)
  process.exit(1)
}
console.log('IMPORT CONTRACT OK (' + ROWS.length + ' row(s))')
