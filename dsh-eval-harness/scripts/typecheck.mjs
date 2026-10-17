// Type-check the bundle package with its own project file.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { BUNDLE_DIR, WORKSPACE_ROOT } from './registry.mjs'

const tsc = join(WORKSPACE_ROOT, 'node_modules', 'typescript', 'bin', 'tsc')
if (!existsSync(tsc)) {
  console.error('typecheck: typescript is missing; run `npm install` first')
  process.exit(1)
}

const project = join(BUNDLE_DIR, 'tsconfig.json')
if (!existsSync(project)) {
  console.error('typecheck: missing ' + project)
  process.exit(1)
}

const result = spawnSync(process.execPath, [tsc, '-p', project, '--noEmit', '--pretty', 'false'], {
  cwd: WORKSPACE_ROOT,
  stdio: 'inherit',
})
process.exit(result.status ?? 1)
