import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { benchmarkEnvironment } from './benchmark/registry.ts'
import type { Config } from './config.ts'
import { credentialPresent } from './model/credentials.ts'
import { resolveModelTarget } from './model/target.ts'
import { probeRequirements, type EnvironmentProbe } from './run/environment.ts'

/** Canonical output value of the `eval_status` tool. */
export interface EvalStatus {
  readonly plugin: 'dsh-eval-harness'
  readonly config: {
    readonly concurrency: number
    readonly outputRoot: string
  }
  readonly runtime: {
    readonly node: string
    readonly platform: string
  }
}

/** The three things a user must confirm before an evaluation may run. */
export interface EvalPlan {
  readonly harness: { readonly profile: string; readonly dshVersion: string }
  readonly model: {
    readonly provider: string
    readonly model: string
    readonly api: string
    readonly baseURL: string
    readonly apiKeyEnv: string
  }
  readonly benchmark: {
    readonly name: string
    readonly language: string
    readonly revision: string
    readonly tasks: string[]
  }
}

/** Canonical output value of the `eval_preflight` tool. */
export interface EvalPreflightResult {
  plan: EvalPlan
  ready: boolean
  requirements: { id: string; command: string[]; reason: string }[]
  probe: EnvironmentProbe[]
  missing: { id: string; reason: string; detail: string }[]
  credential: { env: string; present: boolean }
  notes: string[]
  confirmation: string
  next: string
}

/**
 * Build the `eval_status` tool. It reports plugin identity and the effective
 * row config so an operator can verify activation without reading logs.
 * @param config - the row config resolved by the loader.
 * @returns the registry-ready tool definition.
 */
export function createEvalStatusTool(config: Config): ToolDefinition {
  return defineTool({
    name: 'eval_status',
    description:
      'Report dsh-eval-harness status: plugin identity, effective configuration, and runtime facts.',
    parameters: {},
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
              concurrency: { type: 'integer', required: true },
              outputRoot: { type: 'string', required: true },
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
        },
      },
      render: (_args, value): ContentBlock[] => [
        { type: 'text', text: JSON.stringify(value, null, 2) },
      ],
    },
    execute: async (): Promise<EvalStatus> => ({
      plugin: 'dsh-eval-harness',
      config: { concurrency: config.concurrency, outputRoot: config.outputRoot },
      runtime: { node: process.version, platform: process.platform },
    }),
  })
}

/**
 * Build the `eval_preflight` tool: the mandatory step 0 of an evaluation.
 *
 * It forces the agent to pin down the three decisions an evaluation needs —
 * harness, model, benchmark — resolves the model from the user's own profile,
 * probes the benchmark's environment requirements and the model credential, and
 * asks the agent to present the plan to the user before anything runs.
 * @returns the registry-ready tool definition.
 */
export function createEvalPreflightTool(): ToolDefinition {
  return defineTool({
    name: 'eval_preflight',
    description:
      '评测流程第 0 步（必须先做）：与用户确认三件事——①哪个 harness（profile + dsh 版本）②哪个模型（provider + model，从该 profile 解析）' +
      '③哪个 benchmark（名称 + language + revision + 任务列表）。本工具校验这三项、解析模型配置、探测 benchmark 环境需求与模型凭据，' +
      '返回一份 plan。若 ready=false，按 missing 配置环境后再次调用；ready=true 时把 plan 逐项呈现给用户确认，确认后才能开始评测。' +
      '插件只声明和检测环境，不会安装任何东西。',
    parameters: {
      harnessProfile: {
        type: 'string',
        required: true,
        description: 'harness profile 目录（或 ~/.dsh/profiles 下的 profile 名），用于解析模型配置',
      },
      dshVersion: { type: 'string', required: true, description: '被测 harness 的 dsh 版本' },
      provider: { type: 'string', required: true, description: '模型 provider，如 siliconflow / deepseek-official' },
      model: { type: 'string', required: true, description: '模型 id，如 Qwen/Qwen3-8B / deepseek-flash' },
      benchmark: { type: 'string', required: true, description: 'benchmark 名称，如 aider-polyglot' },
      language: { type: 'string', required: true, description: '语言轨道，如 python' },
      revision: { type: 'string', required: true, description: 'benchmark 的 pinned revision' },
      tasks: { type: 'array', required: true, items: { type: 'string' }, description: '显式任务列表' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          plan: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              harness: {
                type: 'object',
                additionalProperties: false,
                required: true,
                properties: {
                  profile: { type: 'string', required: true },
                  dshVersion: { type: 'string', required: true },
                },
              },
              model: {
                type: 'object',
                additionalProperties: false,
                required: true,
                properties: {
                  provider: { type: 'string', required: true },
                  model: { type: 'string', required: true },
                  api: { type: 'string', required: true },
                  baseURL: { type: 'string', required: true },
                  apiKeyEnv: { type: 'string', required: true },
                },
              },
              benchmark: {
                type: 'object',
                additionalProperties: false,
                required: true,
                properties: {
                  name: { type: 'string', required: true },
                  language: { type: 'string', required: true },
                  revision: { type: 'string', required: true },
                  tasks: { type: 'array', required: true, items: { type: 'string' } },
                },
              },
            },
          },
          ready: { type: 'boolean', required: true },
          requirements: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                command: { type: 'array', required: true, items: { type: 'string' } },
                reason: { type: 'string', required: true },
              },
            },
          },
          probe: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                ok: { type: 'boolean', required: true },
                detail: { type: 'string', required: true },
              },
            },
          },
          missing: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                reason: { type: 'string', required: true },
                detail: { type: 'string', required: true },
              },
            },
          },
          credential: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              env: { type: 'string', required: true },
              present: { type: 'boolean', required: true },
            },
          },
          notes: { type: 'array', required: true, items: { type: 'string' } },
          confirmation: { type: 'string', required: true },
          next: { type: 'string', required: true },
        },
      },
      render: (_args, value): ContentBlock[] => [
        { type: 'text', text: JSON.stringify(value, null, 2) },
      ],
    },
    execute: async (args): Promise<EvalPreflightResult> => {
      const input = args as {
        readonly harnessProfile: string
        readonly dshVersion: string
        readonly provider: string
        readonly model: string
        readonly benchmark: string
        readonly language: string
        readonly revision: string
        readonly tasks: readonly string[]
      }
      const profileDir = resolveProfileDir(input.harnessProfile)
      const target = resolveModelTarget(profileDir, input.provider, input.model)
      const declared = benchmarkEnvironment(input.benchmark, input.language)
      const probe = probeRequirements(declared.requirements)
      const probeById = new Map(probe.map((item) => [item.id, item]))
      const missing = declared.requirements
        .filter((requirement) => probeById.get(requirement.id)?.ok !== true)
        .map((requirement) => ({
          id: requirement.id,
          reason: requirement.reason,
          detail: probeById.get(requirement.id)?.detail ?? '',
        }))
      const credential = { env: target.apiKeyEnv, present: credentialPresent(target.apiKeyEnv) }
      const ready = missing.length === 0 && credential.present
      return {
        plan: {
          harness: { profile: profileDir, dshVersion: input.dshVersion },
          model: {
            provider: target.provider,
            model: target.model,
            api: target.api ?? '',
            baseURL: target.baseURL ?? '',
            apiKeyEnv: target.apiKeyEnv,
          },
          benchmark: {
            name: declared.benchmark,
            language: declared.language,
            revision: input.revision,
            tasks: [...input.tasks],
          },
        },
        ready,
        requirements: declared.requirements.map((requirement) => ({
          id: requirement.id,
          command: [requirement.command, ...requirement.args],
          reason: requirement.reason,
        })),
        probe,
        missing,
        credential,
        notes: [
          ...declared.notes,
          ...(target.listed ? [] : ['模型未在 profile 的 provider models 中列出，按显式指定使用']),
        ],
        confirmation:
          '三件事已确定：harness=' + input.dshVersion + ' @ ' + profileDir +
          '；model=' + target.provider + '/' + target.model +
          '；benchmark=' + declared.benchmark + '/' + declared.language + ' @ ' + input.revision +
          '（' + input.tasks.length + ' 个任务）。',
        next: ready
          ? '把 plan 逐项呈现给用户，请用户确认 harness / model / benchmark 三项；用户确认后再开始评测。'
          : '环境或凭据未就绪：按 missing 与 credential 的说明先配置，然后再次调用 eval_preflight，直到 ready=true。',
      }
    },
  })
}

/** Resolve a profile argument to an existing profile directory. */
function resolveProfileDir(value: string): string {
  if (existsSync(value)) return value
  const candidate = join(homedir(), '.dsh', 'profiles', value)
  if (existsSync(candidate)) return candidate
  throw new Error('eval_preflight: profile not found: ' + value)
}
