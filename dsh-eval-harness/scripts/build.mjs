// Build the bundle package with tsc and verify the published entry exists.
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { BUNDLE_DIR, WORKSPACE_ROOT } from './registry.mjs'

const tsc = join(WORKSPACE_ROOT, 'node_modules', 'typescript', 'bin', 'tsc')
if (!existsSync(tsc)) {
  console.error('build: typescript is missing; run `npm install` first')
  process.exit(1)
}

const project = join(BUNDLE_DIR, 'tsconfig.build.json')
if (!existsSync(project)) {
  console.error('build: missing ' + project)
  process.exit(1)
}

const args = [tsc, '-p', project, '--pretty', 'false']
const result = spawnSync(process.execPath, args, {
  cwd: WORKSPACE_ROOT,
  stdio: 'pipe',
  encoding: 'utf8',
})
// A restricted Windows sandbox can deny piped child stdio (EPERM); retry inherited.
if (result.error !== undefined && result.error.code === 'EPERM') {
  const retry = spawnSync(process.execPath, args, { cwd: WORKSPACE_ROOT, stdio: 'inherit' })
  process.exit(retry.status ?? 1)
}
if (result.status !== 0) {
  if (result.stdout !== null) process.stdout.write(result.stdout)
  if (result.stderr !== null) process.stderr.write(result.stderr)
  process.exit(result.status ?? 1)
}

const entry = join(BUNDLE_DIR, 'lib', 'index.js')
if (!existsSync(entry)) {
  console.error('build: tsc produced no ' + entry)
  process.exit(1)
}

// Ship the dashboard app inside the plugin package: `eval_run` resolves the
// template from `<package>/assets/dashboard/index.html`.
const dashboardApp = join(WORKSPACE_ROOT, 'dashboard')
const dashboardDist = join(dashboardApp, 'dist', 'index.html')
if (!existsSync(dashboardDist) && existsSync(join(dashboardApp, 'node_modules'))) {
  spawnSync('npm', ['--prefix', dashboardApp, 'run', 'build'], {
    cwd: WORKSPACE_ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
}
const assetDir = join(BUNDLE_DIR, 'assets', 'dashboard')
const assetTemplate = join(assetDir, 'index.html')
if (existsSync(dashboardDist)) {
  mkdirSync(assetDir, { recursive: true })
  copyFileSync(dashboardDist, assetTemplate)
  console.log('[build] ' + assetTemplate)
} else {
  console.warn('[build] dashboard template missing; run `npm --prefix dashboard install && npm run dashboard:app`')
}
console.log('[build] ' + entry)
