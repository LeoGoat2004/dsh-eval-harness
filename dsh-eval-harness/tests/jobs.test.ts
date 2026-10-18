import { readFileSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadPersistedJobs, startRunJob } from '../packages/dsh-eval-harness/src/run/jobs.ts'

describe('run job persistence', () => {
  it('writes a job record when the job finishes', async () => {
    const persistDir = mkdtempSync(join(tmpdir(), 'dsh-eval-jobs-'))
    const job = startRunJob(
      async () => ({ runId: 'run-1', runDir: '/tmp/run-1', reportPath: '/tmp/run-1/report.json', totals: { tasks: 1 } }),
      { persistDir, outputDir: '/tmp/runs' },
    )
    // Wait for the async thunk to settle.
    await new Promise((resolve) => setTimeout(resolve, 20))
    const file = join(persistDir, job.token + '.json')
    const persisted = JSON.parse(readFileSync(file, 'utf8')) as {
      state: string
      runId: string
      token: string
      outputDir: string
    }
    expect(persisted.state).toBe('completed')
    expect(persisted.runId).toBe('run-1')
    expect(persisted.token).toBe(job.token)
    expect(persisted.outputDir).toBe('/tmp/runs')
  })

  it('marks a persisted running job as interrupted after a restart', () => {
    const persistDir = mkdtempSync(join(tmpdir(), 'dsh-eval-jobs-'))
    writeFileSync(
      join(persistDir, 'run-stale.json'),
      JSON.stringify({ token: 'run-stale', kind: 'evaluation', startedAt: 1, state: 'running' }),
    )
    const jobs = loadPersistedJobs(persistDir)
    expect(jobs[0]?.state).toBe('interrupted')
    expect(jobs[0]?.error).toContain('restart')
  })

  it('keeps a failed job observable', async () => {
    const persistDir = mkdtempSync(join(tmpdir(), 'dsh-eval-jobs-'))
    const job = startRunJob(
      async () => {
        throw new Error('boom')
      },
      { persistDir },
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    const persisted = JSON.parse(readFileSync(join(persistDir, job.token + '.json'), 'utf8')) as { state: string; error: string }
    expect(persisted.state).toBe('failed')
    expect(persisted.error).toContain('boom')
  })
})
