import Schema from '@deepseek-ai/schemastery'

/** Runtime configuration of the eval harness row. */
export interface Config {
  /** Default number of benchmark tasks executed in parallel. */
  concurrency: number
  /** Root directory for run artifacts; empty means the tool requires an explicit outputDir. */
  outputRoot: string
  /** dsh launcher of the Harness under test; required by the eval_run tool. */
  dshBin: string
}

/**
 * Schemastery schema for this plugin's row config. The Cordis loader validates
 * a row's `config` against it at activation, so defaults live here rather than
 * in `apply()`.
 */
export const Config: Schema<Config> = Schema.object({
  concurrency: Schema.number().min(1).max(16).default(4),
  outputRoot: Schema.string().default(''),
  dshBin: Schema.string().default(''),
})
