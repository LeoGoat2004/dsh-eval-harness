import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import type { Config } from '../config.ts'
import { resolveCredential } from '../model/credentials.ts'
import { resolveModelTarget } from '../model/target.ts'
import { startRunJob } from '../run/jobs.ts'
import { runEvaluation } from '../run/runner.ts'

/** Canonical output value of the `eval_run` tool. */
export interface EvalRunResult {
  token: string
  state: 'running'
  startedAt: number
  outputDir: string
  model: { provider: string; model: string }
  benchmark: { manifest: string; language: string; revision: string; tasks: string[] }
}

/**
 * Build the `eval_run` tool: start one evaluation in the background using the
 * current DSH environment. It never provisions an environment; missing
 * requirements are the Harness/agent/user's job.
 * @param config - the row config resolved by the loader.
 * @returns the registry-ready tool definition.
 */
export function createEvalRunTool(config: Config): ToolDefinition {
  return defineTool({
    name: 'eval_run',
    description:
      '在后台启动一次评测：使用当前 DSH 环境执行 benchmark manifest 定义的任务，返回 job token；' +
      '用 eval_status 查询进度与报告路径。环境配置由 DSH/agent/用户负责，插件不安装任何依赖。' +
      '运行前应先完成 eval_preflight 的三件事确认。',
    parameters: {
      harnessProfile: {
        type: 'string',
        required: true,
        description: 'harness profile 目录（或 ~/.dsh/profiles 下的名字），用于解析模型配置',
      },
      dshVersion: { type: 'string', required: true, description: '被测 harness 的 dsh 版本' },
      provider: { type: 'string', required: true, description: '模型 provider' },
      model: { type: 'string', required: true, description: '模型 id' },
      manifestPath: { type: 'string', required: true, description: 'benchmark manifest 的绝对路径' },
      language: { type: 'string', required: true, description: '语言轨道' },
      revision: { type: 'string', required: true, description: 'benchmark 的 pinned revision' },
      tasks: { type: 'array', required: true, items: { type: 'string' }, description: '显式任务列表' },
      benchmarkRoot: { type: 'string', required: true, description: 'benchmark checkout 根目录' },
      outputDir: {
        type: 'string',
        description: 'run 产物根目录；省略时使用插件配置 outputRoot',
      },
      timeoutMs: { type: 'integer', required: true, description: '每任务超时毫秒' },
      maxSteps: { type: 'integer', required: true, description: '熔断：最大步数' },
      maxIdenticalToolCalls: { type: 'integer', required: true, description: '熔断：连续相同工具调用上限' },
      permissionMode: { type: 'string', required: true, description: 'workspace-write 或 danger-full-access' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          token: { type: 'string', required: true },
          state: { type: 'string', required: true },
          startedAt: { type: 'number', required: true },
          outputDir: { type: 'string', required: true },
          model: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              provider: { type: 'string', required: true },
              model: { type: 'string', required: true },
            },
          },
          benchmark: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              manifest: { type: 'string', required: true },
              language: { type: 'string', required: true },
              revision: { type: 'string', required: true },
              tasks: { type: 'array', required: true, items: { type: 'string' } },
            },
          },
        },
      },
      render: (_args, value): ContentBlock[] => [
        { type: 'text', text: JSON.stringify(value, null, 2) },
      ],
    },
    execute: async (args): Promise<EvalRunResult> => {
      const input = args as {
        readonly harnessProfile: string
        readonly dshVersion: string
        readonly provider: string
        readonly model: string
        readonly manifestPath: string
        readonly language: string
        readonly revision: string
        readonly tasks: readonly string[]
        readonly benchmarkRoot: string
        readonly outputDir?: string
        readonly timeoutMs: number
        readonly maxSteps: number
        readonly maxIdenticalToolCalls: number
        readonly permissionMode: string
      }
      if (config.dshBin === '') {
        throw new Error(
          'eval_run: plugin config `dshBin` is empty; set it to the dsh launcher path of the Harness under test',
        )
      }
      if (input.permissionMode !== 'workspace-write' && input.permissionMode !== 'danger-full-access') {
        throw new Error('eval_run: permissionMode must be workspace-write or danger-full-access')
      }
      const profileDir = resolveProfileDir(input.harnessProfile)
      const target = resolveModelTarget(profileDir, input.provider, input.model)
      const credential = resolveCredential(target.apiKeyEnv)
      if (credential === null) {
        throw new Error(
          'eval_run: credential ' + target.apiKeyEnv + ' not found in the environment or ~/.dsh/.credentials.yaml',
        )
      }
      const outputDir = resolve(input.outputDir ?? config.outputRoot)
      if (outputDir === '') {
        throw new Error('eval_run: pass outputDir or set the plugin config `outputRoot`')
      }
      if (!isAbsolute(input.manifestPath)) {
        throw new Error('eval_run: manifestPath must be an absolute path')
      }
      const benchmarkRoot = resolve(input.benchmarkRoot)
      const env: NodeJS.ProcessEnv = { ...process.env }
      for (const key of Object.keys(env)) {
        if (key.startsWith('DSH_')) delete env[key]
      }
      env[target.apiKeyEnv] = credential
      env.DSH_PERMISSION_MODE = input.permissionMode
      const startedAt = Date.now()
      const job = startRunJob(() =>
        runEvaluation({
          benchmarkRoot,
          benchmarkRevision: input.revision,
          language: input.language,
          taskIds: input.tasks,
          dshBin: config.dshBin,
          dshVersion: input.dshVersion,
          outputDir,
          profileName: 'eval-run',
          timeoutMs: input.timeoutMs,
          permissionMode: input.permissionMode as 'workspace-write' | 'danger-full-access',
          env,
          model: target,
          manifestPath: input.manifestPath,
          guard: { maxSteps: input.maxSteps, maxIdenticalToolCalls: input.maxIdenticalToolCalls },
        }),
      )
      return {
        token: job.token,
        state: 'running',
        startedAt,
        outputDir,
        model: { provider: target.provider, model: target.model },
        benchmark: {
          manifest: input.manifestPath,
          language: input.language,
          revision: input.revision,
          tasks: [...input.tasks],
        },
      }
    },
  })
}

/** Resolve a profile argument to an existing profile directory. */
function resolveProfileDir(value: string): string {
  if (existsSync(value)) return value
  const candidate = join(homedir(), '.dsh', 'profiles', value)
  if (existsSync(candidate)) return candidate
  throw new Error('eval_run: profile not found: ' + value)
}
