import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Config } from '../config.ts'
import { getRunJob, listRunJobs } from '../run/jobs.ts'

/** Canonical output value of the `eval_status` tool. */
export interface EvalStatus {
  readonly plugin: 'dsh-eval-harness'
  readonly config: {
    readonly outputRoot: string
    readonly dshBin: string
  }
  readonly runtime: {
    readonly node: string
    readonly platform: string
  }
  readonly jobs: {
    token: string
    state: string
    startedAt: number
    finishedAt?: number
    runId?: string
    runDir?: string
    reportPath?: string
    dashboardPath?: string
    error?: string
  }[]
}

/**
 * Build the `eval_status` tool: plugin identity, effective config and the
 * background evaluation jobs started by this plugin process.
 * @param config - the row config resolved by the loader.
 * @returns the registry-ready tool definition.
 */
export function createEvalStatusTool(config: Config): ToolDefinition {
  return defineTool({
    name: 'eval_status',
    description:
      'Report dsh-eval-harness status: identity, effective configuration, and the state of background evaluation jobs started by eval_run.',
    parameters: {
      token: {
        type: 'string',
        description: 'Optional job token returned by eval_run; omit to list all tracked jobs.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          plugin: { type: 'string', required: true },
          config: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
                  outputRoot: { type: 'string', required: true },
              dshBin: { type: 'string', required: true },
            },
          },
          runtime: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              node: { type: 'string', required: true },
              platform: { type: 'string', required: true },
            },
          },
          jobs: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                token: { type: 'string', required: true },
                state: { type: 'string', required: true },
                startedAt: { type: 'number', required: true },
                finishedAt: { type: 'number' },
                runId: { type: 'string' },
                runDir: { type: 'string' },
                reportPath: { type: 'string' },
        dashboardPath: { type: 'string' },
                error: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value): ContentBlock[] => [
        { type: 'text', text: JSON.stringify(value, null, 2) },
      ],
    },
    execute: async (args): Promise<EvalStatus> => {
      const input = args as { readonly token?: string }
      const jobs =
        input.token === undefined
          ? listRunJobs()
          : [getRunJob(input.token)].filter((job): job is NonNullable<typeof job> => job !== undefined)
      return {
        plugin: 'dsh-eval-harness',
        config: { outputRoot: config.outputRoot, dshBin: config.dshBin },
        runtime: { node: process.version, platform: process.platform },
        jobs: jobs.map((job) => ({
          token: job.token,
          state: job.state,
          startedAt: job.startedAt,
          ...(job.finishedAt === undefined ? {} : { finishedAt: job.finishedAt }),
          ...(job.runId === undefined ? {} : { runId: job.runId }),
          ...(job.runDir === undefined ? {} : { runDir: job.runDir }),
          ...(job.reportPath === undefined ? {} : { reportPath: job.reportPath }),
      ...(job.dashboardPath === undefined ? {} : { dashboardPath: job.dashboardPath }),
          ...(job.error === undefined ? {} : { error: job.error }),
        })),
      }
    },
  })
}
