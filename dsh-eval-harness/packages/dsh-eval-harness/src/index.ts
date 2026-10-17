import type { Context } from '@deepseek-ai/cordis'
import type { Config as EvalConfig } from './config.ts'
import { createEvalPreflightTool, createEvalStatusTool } from './tools.ts'

export { Config } from './config.ts'
export { createEvalPreflightTool, createEvalStatusTool } from './tools.ts'
export type { EvalPreflightResult, EvalStatus } from './tools.ts'

/** Plugin identity the loader and the patch row agree on. */
export const name = 'eval-harness-run'

/** The tool registry is the only host service this plugin needs today. */
export const inject = ['tools']

/**
 * Mount the eval harness plugin.
 * @param ctx - the Cordis context provided by the loader.
 * @param config - row config validated by {@link Config}.
 */
export function apply(ctx: Context, config: EvalConfig): void {
  ctx.tools.register(createEvalStatusTool(config))
  ctx.tools.register(createEvalPreflightTool())
}
