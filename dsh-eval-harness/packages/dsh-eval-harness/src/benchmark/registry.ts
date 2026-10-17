import type { EnvironmentRequirement } from '../run/environment.ts'
import { AIDER_PYTHON_ENVIRONMENT } from './aider.ts'

/** Environment a benchmark adapter declares for one language track. */
export interface BenchmarkEnvironmentInfo {
  readonly benchmark: string
  readonly language: string
  readonly requirements: readonly EnvironmentRequirement[]
  readonly notes: readonly string[]
}

/**
 * Resolve the environment requirements a benchmark declares. The plugin never
 * installs anything: this is the declaration half of the eval preflight step.
 * @param benchmark - benchmark name, e.g. `aider-polyglot`.
 * @param language - language track, e.g. `python`.
 * @returns declared requirements and adapter notes.
 */
export function benchmarkEnvironment(benchmark: string, language: string): BenchmarkEnvironmentInfo {
  if (benchmark === 'aider-polyglot') {
    if (language === 'python') {
      return { benchmark, language, requirements: AIDER_PYTHON_ENVIRONMENT, notes: [] }
    }
    return {
      benchmark,
      language,
      requirements: [],
      notes: ['aider-polyglot 的 ' + language + ' 轨道尚未声明环境需求，请自行确认运行时已就绪'],
    }
  }
  throw new Error(
    'eval_preflight: unsupported benchmark "' + benchmark + '" (supported: aider-polyglot)',
  )
}
