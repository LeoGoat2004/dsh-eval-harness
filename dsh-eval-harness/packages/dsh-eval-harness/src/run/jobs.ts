/** Background evaluation jobs: in-memory registry plus durable job records. */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** One background run started by the `eval_run` tool. */
export interface RunJob {
  readonly token: string
  readonly kind: 'evaluation'
  readonly startedAt: number
  finishedAt?: number
  state: 'running' | 'completed' | 'failed'
  runId?: string
  runDir?: string
  reportPath?: string
  dashboardPath?: string
  /** Set when dashboard generation failed; run evidence is still valid. */
  dashboardError?: string
  totals?: unknown
  error?: string
}

const MAX_JOBS = 20
const jobs = new Map<string, RunJob>()

/**
 * Start one background evaluation job.
 * @param run - thunk returning the run summary once finished.
 * @param options - optional durable job directory; records survive a restart.
 * @returns the tracked job record (state `running`).
 */
export function startRunJob(
  run: () => Promise<{
    runId: string
    runDir: string
    reportPath: string
    totals: unknown
    dashboardPath?: string
    dashboardError?: string
  }>,
  options: { readonly persistDir?: string } = {},
): RunJob {
  const token = 'run-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
  const job: RunJob = { token, kind: 'evaluation', startedAt: Date.now(), state: 'running' }
  jobs.set(token, job)
  persistJob(job, options.persistDir)
  void run()
    .then((summary) => {
      job.state = 'completed'
      job.finishedAt = Date.now()
      job.runId = summary.runId
      job.runDir = summary.runDir
      job.reportPath = summary.reportPath
      job.dashboardPath = summary.dashboardPath
      job.dashboardError = summary.dashboardError
      job.totals = summary.totals
      persistJob(job, options.persistDir)
    })
    .catch((error: unknown) => {
      job.state = 'failed'
      job.finishedAt = Date.now()
      job.error = String(error)
      persistJob(job, options.persistDir)
    })
  while (jobs.size > MAX_JOBS) {
    const oldest = jobs.keys().next().value
    if (oldest === undefined) break
    jobs.delete(oldest)
  }
  return job
}

/** List tracked jobs, newest first; durable records fill in after a restart. */
export function listRunJobs(persistDir?: string): RunJob[] {
  const merged = new Map<string, RunJob>()
  for (const job of loadPersistedJobs(persistDir)) merged.set(job.token, job)
  for (const job of jobs.values()) merged.set(job.token, job)
  return [...merged.values()].sort((a, b) => b.startedAt - a.startedAt)
}

/** Look up one job by token, falling back to its durable record. */
export function getRunJob(token: string, persistDir?: string): RunJob | undefined {
  const memory = jobs.get(token)
  if (memory !== undefined) return memory
  return loadPersistedJobs(persistDir).find((job) => job.token === token)
}

/** Load every durable job record in a directory, tolerating bad files. */
export function loadPersistedJobs(persistDir: string | undefined): RunJob[] {
  if (persistDir === undefined || !existsSync(persistDir)) return []
  const loaded: RunJob[] = []
  for (const name of readdirSync(persistDir)) {
    if (!name.endsWith('.json')) continue
    try {
      const parsed = JSON.parse(readFileSync(join(persistDir, name), 'utf8')) as RunJob
      if (typeof parsed.token === 'string' && typeof parsed.startedAt === 'number') loaded.push(parsed)
    } catch {
      // A torn record must not break status reporting.
    }
  }
  return loaded
}

/** Write one job record atomically; persistence failures never fail the job. */
function persistJob(job: RunJob, persistDir: string | undefined): void {
  if (persistDir === undefined) return
  try {
    mkdirSync(persistDir, { recursive: true })
    const target = join(persistDir, job.token + '.json')
    const temporary = target + '.tmp'
    writeFileSync(temporary, JSON.stringify(job, null, 2) + '\n')
    try {
      renameSync(temporary, target)
    } catch {
      // Windows can refuse a rename while another handle is open; fall back.
      writeFileSync(target, JSON.stringify(job, null, 2) + '\n')
    }
  } catch {
    // Persistence is best-effort; the in-memory record remains authoritative.
  }
}
