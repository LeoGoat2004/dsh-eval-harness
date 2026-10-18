/** Orthogonal task semantics: how the episode ended vs. what the verifier said. */

/** How the episode itself ended; independent of the benchmark outcome. */
export type ExecutionStatus =
  | 'completed'
  | 'timeout'
  | 'guard_stopped'
  | 'agent_crashed'
  | 'trace_corrupt'
  | 'verifier_error'
  | 'not_started'

/** Benchmark outcome; only a trustworthy episode may produce `passed`/`failed`. */
export type TaskOutcome = 'passed' | 'failed' | 'ungraded'

/** Inputs used to classify one completed (or aborted) task. */
export interface TaskStatusInput {
  /** False when the task could not even start (e.g. workspace materialization failed). */
  readonly started: boolean
  readonly timedOut: boolean
  readonly guard: { readonly reason: string } | null
  readonly exitCode: number | null
  readonly traceError: string | undefined
  readonly verify: {
    readonly ok: boolean
    readonly total: number
    readonly error?: string
  } | null
}

/** Classified task status; `error` carries the concrete reason when there is one. */
export interface TaskStatus {
  readonly executionStatus: ExecutionStatus
  readonly taskOutcome: TaskOutcome
  readonly error?: string
}

/**
 * Classify one task without conflating execution failures with benchmark results.
 *
 * A timeout, guard stop, crash, corrupted trace or verifier error means the run
 * cannot be graded, even if a verifier happened to pass; those become `ungraded`
 * so a success rate can never be inflated by a broken episode.
 * @param input - observed episode and verifier facts.
 * @returns execution status, task outcome and an optional reason.
 */
export function classifyTaskStatus(input: TaskStatusInput): TaskStatus {
  if (!input.started) return { executionStatus: 'not_started', taskOutcome: 'ungraded' }
  if (input.guard !== null) {
    return {
      executionStatus: 'guard_stopped',
      taskOutcome: 'ungraded',
      error: 'guard: ' + input.guard.reason,
    }
  }
  if (input.timedOut) {
    return { executionStatus: 'timeout', taskOutcome: 'ungraded', error: 'timeout' }
  }
  // A non-zero exit is a crashed episode even when it also left no trace: the
  // crash is the earlier, more specific observation.
  if (input.exitCode !== 0) {
    return {
      executionStatus: 'agent_crashed',
      taskOutcome: 'ungraded',
      error: 'agent exit code ' + String(input.exitCode),
    }
  }
  if (input.traceError !== undefined) {
    return { executionStatus: 'trace_corrupt', taskOutcome: 'ungraded', error: input.traceError }
  }
  if (input.verify === null) {
    return { executionStatus: 'verifier_error', taskOutcome: 'ungraded', error: 'verifier did not run' }
  }
  if (input.verify.error !== undefined) {
    return { executionStatus: 'verifier_error', taskOutcome: 'ungraded', error: input.verify.error }
  }
  if (input.verify.total === 0) {
    return { executionStatus: 'verifier_error', taskOutcome: 'ungraded', error: 'verifier reported no checks' }
  }
  return {
    executionStatus: 'completed',
    taskOutcome: input.verify.ok ? 'passed' : 'failed',
  }
}
