// Naming and identity contract: the bundle manifest, the package exports, the
// registered row ids and the patch rows must agree, and no orphan row may exist.
import { join } from 'node:path'
import { load } from 'js-yaml'
import { BUNDLE_DIR, BUNDLE_PKG, ROWS, readJson, readText } from './registry.mjs'

const failures = []
const check = (condition, message) => {
  if (!condition) failures.push(message)
}

const bundleManifest = readJson(join(BUNDLE_DIR, 'package.json'))
check(bundleManifest.name === BUNDLE_PKG, 'bundle package name must be ' + BUNDLE_PKG)
check(
  bundleManifest.dsh?.bundle?.patch === './cordis.patch.yml',
  'bundle must point dsh.bundle.patch at ./cordis.patch.yml',
)
check(
  bundleManifest.exports?.['./cordis.patch.yml'] === './cordis.patch.yml',
  'package exports must expose ./cordis.patch.yml',
)
check(
  bundleManifest.main === 'lib/index.js' && bundleManifest.types === 'lib/index.d.ts',
  'package main/types must point at built lib output',
)

const patchRows = (load(readText(join(BUNDLE_DIR, 'cordis.patch.yml'))) ?? []).flatMap(
  (layer) => layer.insert ?? [],
)
const knownRowIds = new Set(ROWS.map((row) => row.id))

for (const row of ROWS) {
  const patchRow = patchRows.find((candidate) => candidate.id === row.id)
  check(patchRow !== undefined, 'patch is missing row ' + row.id)
  check(patchRow?.name === BUNDLE_PKG, 'patch row ' + row.id + ' must mount ' + BUNDLE_PKG)
}

for (const patchRow of patchRows) {
  if (
    typeof patchRow.id === 'string' &&
    patchRow.id.startsWith('eval-harness-') &&
    !knownRowIds.has(patchRow.id)
  ) {
    failures.push('orphan patch row ' + patchRow.id + ' is not registered in scripts/registry.mjs')
  }
}

if (failures.length > 0) {
  console.error('NAMING CONTRACT FAIL')
  for (const failure of failures) console.error('  - ' + failure)
  process.exit(1)
}
console.log('NAMING CONTRACT OK (' + ROWS.length + ' row(s), ' + patchRows.length + ' patch row(s))')
