// Development CLI for the standalone dashboard generator; the generator itself
// ships with the plugin package so installed plugins can produce dashboards.
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { generateDashboard } from '../packages/dsh-eval-harness/assets/dashboard/generate.mjs'

const args = {}
for (let index = 2; index < process.argv.length; index += 1) {
  if (!process.argv[index].startsWith('--')) continue
  args[process.argv[index].slice(2)] = process.argv[index + 1]
  index += 1
}
if (args.run === undefined) {
  console.error('dashboard: --run <run-dir> is required')
  process.exit(2)
}
const workspaceRoot = resolve(import.meta.dirname, '..')
const templatePath = resolve(args.dist ?? resolve(workspaceRoot, 'dashboard', 'dist', 'index.html'))
if (!existsSync(templatePath)) {
  console.error('dashboard: dashboard/dist/index.html is missing; run `npm run dashboard:app` first')
  process.exit(2)
}
try {
  const result = generateDashboard(resolve(args.run), { templatePath })
  console.log(JSON.stringify(result, null, 2))
} catch (error) {
  console.error(String(error))
  process.exit(1)
}
