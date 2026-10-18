// Pack smoke test: build a tarball, install it into a clean directory and prove
// the installed package can generate a dashboard from run artifacts. This is the
// acceptance check that a published plugin is usable, not only the checkout.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const workspaceRoot = resolve(import.meta.dirname, '..')
const packageDir = join(workspaceRoot, 'packages', 'dsh-eval-harness')
const workDir = mkdtempSync(join(tmpdir(), 'dsh-eval-pack-'))
const failures = []
const check = (condition, message) => {
  if (!condition) failures.push(message)
}

/**
 * Run npm portably: Windows has no `npm` executable, so prefer the npm CLI
 * script that invokes this test and fall back to a shelled `npm`.
 * @param args - npm arguments.
 * @param cwd - working directory.
 */
function npm(args, cwd) {
  const cli = process.env.npm_execpath
  if (cli !== undefined && cli !== '') {
    execFileSync(process.execPath, [cli, ...args], { cwd, stdio: 'pipe' })
    return
  }
  execFileSync('npm', args, { cwd, stdio: 'pipe', shell: process.platform === 'win32' })
}

try {
  const packDir = join(workDir, 'pack')
  mkdirSync(packDir, { recursive: true })
  npm(['pack', '--pack-destination', packDir], packageDir)
  const tarball = execFileSync('node', ['-e', 'process.stdout.write(require("node:fs").readdirSync(process.argv[1]).find((n)=>n.endsWith(".tgz")) ?? "")', packDir], {
    encoding: 'utf8',
  })
  check(tarball !== '', 'npm pack must produce a tarball')

  const appDir = join(workDir, 'app')
  mkdirSync(appDir, { recursive: true })
  writeFileSync(join(appDir, 'package.json'), JSON.stringify({ name: 'pack-smoke', private: true }))
  npm(['install', '--no-audit', '--no-fund', join(packDir, tarball)], appDir)

  const installed = join(appDir, 'node_modules', 'dsh-eval-harness')
  check(existsSync(join(installed, 'assets', 'dashboard', 'index.html')), 'installed package must ship the dashboard template')
  check(existsSync(join(installed, 'lib', 'report', 'dashboard.js')), 'installed package must ship the dashboard generator facade')

  const runDir = join(workDir, 'run')
  mkdirSync(join(runDir, 'tasks', '01-t1'), { recursive: true })
  writeFileSync(
    join(runDir, 'run.json'),
    JSON.stringify({ runId: 'pack-smoke', benchmark: 'fixture', benchmarkRevision: 'r1', dshVersion: '0.2.1', profile: 'eval', model: { provider: 'deepseek-official', model: 'deepseek-flash' }, backend: 'local' }),
  )
  writeFileSync(
    join(runDir, 'report.json'),
    JSON.stringify({ benchmark: { name: 'fixture', language: 'node', tasks: ['t1'] }, totals: { tasks: 1, passed: 1, failed: 0, ungraded: 0, executionErrors: 0, durationMs: 1, totalTokens: 1, toolCalls: 1 }, diagnostics: [] }),
  )
  writeFileSync(join(runDir, 'tasks', '01-t1', 'task.json'), JSON.stringify({ id: 't1', executionStatus: 'completed', taskOutcome: 'passed' }))

  const module = await import(pathToFileURL(join(installed, 'lib', 'report', 'dashboard.js')).href)
  const result = await module.generateDashboard(runDir)
  check(typeof result.dashboard === 'string' && existsSync(result.dashboard), 'installed package must generate a dashboard')
  check(readFileSync(result.dashboard, 'utf8').includes('__DASHBOARD_DATA__'), 'dashboard must contain injected data')
} catch (error) {
  failures.push('pack smoke threw: ' + String(error))
} finally {
  rmSync(workDir, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error('PACK SMOKE FAIL')
  for (const failure of failures) console.error('  - ' + failure)
  process.exit(1)
}
console.log('PACK SMOKE OK (tarball install, dashboard generation)')
