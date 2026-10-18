/** Background evaluation jobs: in-memory registry plus durable job records. */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** One background run started by the `eval_run` tool. */
export interface RunJob {
  readonly token: string
  readonly kind: 'evaluation'
  readonly startedAt: number
  finishedAt?: number
  state: 'running' | 'completed' | 'failed' | 'interrupted'
  /** Run artifact directory; kept so a status scan can report where it went. */
  outputDir?: string
  /** Last heartbeat from the running process (stale running jobs are interrupted). */
  heartbeatAt?: number
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
const MAX_PERSISTED = 50
const HEARTBEAT_MS = 5_000
const jobs = new Map<string, RunJob>()

/**
 * Start one background evaluation job.
 * @param run - thunk returning the run summary once finished.
 * @param options - durable job directory, output directory and retention.
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
  options: { readonly persistDir?: string; readonly outputDir?: string } = {},
): RunJob {
  const token = 'run-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
  const job: RunJob = {
    token,
    kind: 'evaluation',
    startedAt: Date.now(),
    heartbeatAt: Date.now(),
    state: 'running',
    ...(options.outputDir === undefined ? {} : { outputDir: options.outputDir }),
  }
  jobs.set(token, job)
  persistJob(job, options.persistDir)
  const heartbeat = setInterval(() => {
    if (job.state !== 'running') return
    job.heartbeatAt = Date.now()
    persistJob(job, options.persistDir)
  }, HEARTBEAT_MS)
  heartbeat.unref?.()
  void run()
    .then((summary) => {
      clearInterval(heartbeat)
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
      clearInterval(heartbeat)
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
      if (typeof parsed.token !== 'string' || typeof parsed.startedAt !== 'number') continue
      // A process cannot be running after a restart: a persisted `running`
      // record without a live in-memory owner is a dead job.
      loaded.push(
        parsed.state === 'running'
          ? { ...parsed, state: 'interrupted', error: 'interrupted by process restart' }
          : parsed,
      )
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
    prunePersisted(persistDir)
  } catch {
    // Persistence is best-effort; the in-memory record remains authoritative.
  }
}

/** Keep only the newest job records so the jobs directory cannot grow forever. */
function prunePersisted(persistDir: string): void {
  const records: { name: string; startedAt: number }[] = []
  for (const name of readdirSync(persistDir)) {
    if (!name.endsWith('.json')) continue
    try {
      const parsed = JSON.parse(readFileSync(join(persistDir, name), 'utf8')) as { startedAt?: unknown }
      records.push({ name, startedAt: typeof parsed.startedAt === 'number' ? parsed.startedAt : 0 })
    } catch {
      // Leave unreadable records alone; they are ignored by loadPersistedJobs.
    }
  }
  records.sort((a, b) => b.startedAt - a.startedAt)
  for (const stale of records.slice(MAX_PERSISTED)) {
    try {
      renameSync(join(persistDir, stale.name), join(persistDir, stale.name + '.old'))
    } catch {
      // Best effort only; retention never fails a run.
    }
  }
}
