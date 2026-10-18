/** Data contract injected by scripts/dashboard.mjs as `window.__DASHBOARD_DATA__`. */

export interface ModelRef {
  readonly provider: string
  readonly model: string
}

export interface RunManifest {
  readonly runId: string
  readonly benchmark: string
  readonly benchmarkRevision: string
  readonly dshVersion: string
  readonly profile: string
  readonly model: ModelRef
  readonly backend: string
  readonly timeoutMs?: number
  readonly startedAt?: string
}

export interface TraceMetrics {
  readonly turns: number
  readonly steps: number
  readonly toolCalls: number
  readonly toolResults: number
  readonly toolErrors: number
  readonly retries: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly reasoningTokens: number
  readonly totalTokens: number
  readonly contextTokens: number
  readonly llmMs: number
  readonly toolMs: number
  readonly latencyMs: number
}

export interface EventRow {
  readonly seq: number
  readonly time: number
  readonly type: string
  readonly turn: number
  readonly step: number
  readonly name?: string
  readonly summary?: string
  readonly error?: boolean
}

/** One test case produced by the benchmark's native verifier. */
export interface CheckItem {
  readonly id: string
  readonly pass: boolean
  readonly skipped: boolean
}

export interface TaskChecks {
  readonly passed: number
  readonly total: number
  readonly ok: boolean
  readonly error?: string
  readonly items: readonly CheckItem[]
}

export interface TaskData {
  readonly id: string
  /** Derived display status; see executionStatus/taskOutcome for the truth. */
  readonly status: 'passed' | 'failed' | 'error'
  readonly executionStatus?: string
  readonly taskOutcome?: 'passed' | 'failed' | 'ungraded'
  readonly durationMs: number
  readonly exitCode: number | null
  readonly timedOut: boolean
  readonly metrics: TraceMetrics | null
  readonly checks: TaskChecks | null
  readonly error?: string
  /** Set when the loop guard stopped this episode. */
  readonly guard?: { readonly reason: string } | null
  /** Provider/model the trace actually requested. */
  readonly observedModel?: { readonly provider: string; readonly model: string } | null
  readonly events: readonly EventRow[]
  readonly artifacts: {
    readonly trace: string | null
    readonly workspace: string | null
    readonly verifyLog: string | null
  }
}

export type FindingLayer = 'model' | 'harness' | 'environment' | 'benchmark' | 'adapter' | 'unknown'

export interface Finding {
  readonly kind: string
  readonly layer: FindingLayer
  readonly note: string
  readonly label: string
  readonly count: number
  readonly tasks: readonly string[]
  readonly confidence: 'confirmed' | 'suspicious' | 'unresolved'
}

/** Recorded evaluation-environment facts. */
export interface RunEnvironment {
  readonly recorded: boolean
  readonly backend: string
  readonly platform?: string
  readonly arch?: string
  readonly node?: string
  readonly workspaceRoot?: string
  readonly dshHome?: string
  readonly profile?: string
  readonly sandbox?: string
  readonly approval?: string
  readonly network?: { readonly policy: 'direct' | 'proxy-configured' | string }
  /** Confirmed model target (credential value is never recorded). */
  readonly model?: {
    readonly provider: string
    readonly model: string
    readonly api: string | null
    readonly baseURL: string | null
    readonly apiKeyEnv: string
  }
  /** Benchmark-declared environment requirements and probe results. */
  readonly requirements?: readonly {
    readonly id: string
    readonly ok: boolean
    readonly detail: string
  }[]
  readonly preflight?: {
    readonly ok: boolean
    readonly checks: readonly { readonly name: string; readonly ok: boolean; readonly detail: string }[]
  }
}

export interface RunTotals {
  readonly tasks: number
  readonly passed: number
  readonly failed: number
  /** Tasks not graded because the episode was untrustworthy. */
  readonly ungraded: number
  /** Tasks whose episode did not complete cleanly. */
  readonly executionErrors: number
  readonly durationMs: number
  readonly totalTokens: number
  readonly toolCalls: number
  readonly toolErrors: number
}

export interface DashboardData {
  readonly generatedAt: string
  readonly manifest: RunManifest
  readonly benchmark: {
    readonly name: string
    readonly language: string
    readonly tasks: readonly string[]
  }
  readonly totals: RunTotals
  readonly environment: RunEnvironment
  /** Declared vs trace-observed model; `ok` is null when no request header exists. */
  readonly modelVerification?: {
    readonly declared: { readonly provider: string; readonly model: string }
    readonly observed: { readonly provider: string; readonly model: string } | null
    readonly ok: boolean | null
  } | null
  /** Hermetic-prompt check: whether any trace row mentions the user home path. */
  readonly isolation?: {
    readonly clean: boolean
    readonly homeDirLeaks: readonly { readonly task: string; readonly seq: number; readonly type: string }[]
  }
  readonly tasks: readonly TaskData[]
  readonly findings: readonly Finding[]
}
