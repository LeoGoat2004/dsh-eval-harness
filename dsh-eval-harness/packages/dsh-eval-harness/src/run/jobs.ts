/** In-memory registry of background evaluation jobs for this plugin process. */

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
 * @param token - optional caller-supplied token; generated when omitted.
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
): RunJob {
  const token = 'run-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
  const job: RunJob = { token, kind: 'evaluation', startedAt: Date.now(), state: 'running' }
  jobs.set(token, job)
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
    })
    .catch((error: unknown) => {
      job.state = 'failed'
      job.finishedAt = Date.now()
      job.error = String(error)
    })
  while (jobs.size > MAX_JOBS) {
    const oldest = jobs.keys().next().value
    if (oldest === undefined) break
    jobs.delete(oldest)
  }
  return job
}

/** List tracked jobs, newest first. */
export function listRunJobs(): RunJob[] {
  return [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt)
}

/** Look up one job by token. */
export function getRunJob(token: string): RunJob | undefined {
  return jobs.get(token)
}
