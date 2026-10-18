import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { generateDashboard } from '../packages/dsh-eval-harness/src/report/dashboard.ts'

/** Create a minimal completed run that the generator can read. */
function runFixture(): string {
  const runDir = mkdtempSync(join(tmpdir(), 'dsh-eval-dashboard-'))
  writeFileSync(
    join(runDir, 'run.json'),
    JSON.stringify({
      runId: 'fixture',
      benchmark: 'fixture',
      benchmarkRevision: 'r1',
      dshVersion: '0.2.0',
      profile: 'eval',
      model: { provider: 'deepseek-official', model: 'deepseek-flash' },
      backend: 'local',
      startedAt: new Date().toISOString(),
    }),
  )
  writeFileSync(
    join(runDir, 'report.json'),
    JSON.stringify({
      benchmark: { name: 'fixture', language: 'node', tasks: ['t1'] },
      totals: { tasks: 1, passed: 1, failed: 0, ungraded: 0, executionErrors: 0, durationMs: 10, totalTokens: 10, toolCalls: 1 },
      diagnostics: [],
    }),
  )
  const taskDir = join(runDir, 'tasks', '01-t1')
  mkdirSync(taskDir, { recursive: true })
  writeFileSync(
    join(taskDir, 'task.json'),
    JSON.stringify({ id: 't1', executionStatus: 'completed', taskOutcome: 'passed', durationMs: 10 }),
  )
  return runDir
}

describe('generateDashboard', () => {
  it('writes a self-contained dashboard with injected data', async () => {
    const runDir = runFixture()
    const template = join(runDir, 'template.html')
    writeFileSync(template, '<html><head></head><body>dashboard</body></html>')
    const result = await generateDashboard(runDir, { templatePath: template })
    expect(result.tasks).toBe(1)
    const html = readFileSync(result.dashboard, 'utf8')
    expect(html).toContain('__DASHBOARD_DATA__')
    expect(html).toContain('"runId":"fixture"')
  })

  it('fails explicitly when the template is missing', async () => {
    const runDir = runFixture()
    await expect(generateDashboard(runDir, { templatePath: join(runDir, 'missing.html') })).rejects.toThrow(
      'dashboard: template is missing',
    )
  })
})
