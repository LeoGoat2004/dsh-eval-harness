import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { loadManifest, manifestRequirements } from '../benchmark/manifest.ts'
import { credentialPresent } from '../model/credentials.ts'
import { resolveModelTarget } from '../model/target.ts'
import { auditHarnessProfile } from '../run/environment-audit.ts'
import { probeRequirements, type EnvironmentProbe } from '../run/environment.ts'

/** One benchmark requirement with its probe command. */
export interface PreflightRequirement {
  readonly id: string
  readonly command: string[]
  readonly reason: string
}

/** Canonical output value of the `eval_preflight` tool. */
export interface EvalPreflightResult {
  plan: {
    harness: { profile: string; dshVersion: string }
    model: {
      provider: string
      model: string
      api: string
      baseURL: string
      apiKeyEnv: string
    }
    benchmark: { name: string; language: string; revision: string; tasks: string[] }
  }
  ready: boolean
  requirements: PreflightRequirement[]
  probe: EnvironmentProbe[]
  missing: { id: string; reason: string; detail: string }[]
  credential: { env: string; present: boolean }
  harnessAudit: { clean: boolean; checks: { id: string; ok: boolean; detail: string }[]; notes: string[] }
  notes: string[]
  confirmation: string
  next: string
}

/**
 * Build the `eval_preflight` tool: confirm the three decisions, resolve the
 * model, probe the benchmark environment, and audit the environment for
 * host-local leakage risks.
 * @returns the registry-ready tool definition.
 */
export function createEvalPreflightTool(): ToolDefinition {
  return defineTool({
    name: 'eval_preflight',
    description:
      '评测流程第 0 步（必须先做）：与用户确认三件事——①哪个 harness（profile + dsh 版本）②哪个模型（provider + model，从该 profile 解析）' +
      '③哪个 benchmark（名称 + language + revision + 任务列表）。本工具解析模型配置、探测 benchmark 环境需求与模型凭据、并静态审计环境是否可能加载用户级 skills/指令/凭据，返回 plan。' +
      '若 ready=false，按 missing 配置环境后再次调用；ready=true 时把 plan 交给用户确认，确认后才能开始评测。插件只声明和检测环境，不会安装任何东西。',
    parameters: {
      harnessProfile: {
        type: 'string',
        required: true,
        description: 'harness profile 目录（或 ~/.dsh/profiles 下的 profile 名），用于解析模型配置',
      },
      dshVersion: { type: 'string', required: true, description: '被测 harness 的 dsh 版本' },
      provider: { type: 'string', required: true, description: '模型 provider，如 siliconflow / deepseek-official' },
      model: { type: 'string', required: true, description: '模型 id，如 Qwen/Qwen3-8B / deepseek-flash' },
      manifestPath: {
        type: 'string',
        required: true,
        description: 'benchmark manifest 的绝对路径（环境需求以它为准）',
      },
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
          harnessAudit: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              clean: { type: 'boolean', required: true },
              checks: {
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
              notes: { type: 'array', required: true, items: { type: 'string' } },
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
        readonly manifestPath: string
        readonly language: string
        readonly revision: string
        readonly tasks: readonly string[]
      }
      const profileDir = resolveProfileDir(input.harnessProfile)
      const target = resolveModelTarget(profileDir, input.provider, input.model)
      const manifest = loadManifest(input.manifestPath).manifest
      const requirements = manifestRequirements(manifest)
      const probe = probeRequirements(requirements)
      const probeById = new Map(probe.map((item) => [item.id, item]))
      const missing = requirements
        .filter((requirement) => probeById.get(requirement.id)?.ok !== true)
        .map((requirement) => ({
          id: requirement.id,
          reason: requirement.reason,
          detail: probeById.get(requirement.id)?.detail ?? '',
        }))
      const credential = { env: target.apiKeyEnv, present: credentialPresent(target.apiKeyEnv) }
      const audit = auditHarnessProfile(profileDir)
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
            name: manifest.name,
            language: input.language,
            revision: input.revision,
            tasks: [...input.tasks],
          },
        },
        ready,
        requirements: requirements.map((requirement) => ({
          id: requirement.id,
          command: [requirement.command, ...requirement.args],
          reason: requirement.reason,
        })),
        probe,
        missing,
        credential,
        harnessAudit: {
          clean: audit.clean,
          checks: audit.checks.map((check) => ({ id: check.id, ok: check.ok, detail: check.detail })),
          notes: [...audit.notes],
        },
        notes: [
          ...[],
          ...(target.listed ? [] : ['模型未在 profile 的 provider models 中列出，按显式指定使用']),
          ...(audit.clean ? [] : ['环境审计发现宿主泄漏风险，见 harnessAudit.checks']),
        ],
        confirmation:
          '三件事已确定：harness=' + input.dshVersion + ' @ ' + profileDir +
          '；model=' + target.provider + '/' + target.model +
          '；benchmark=' + manifest.name + '/' + input.language + ' @ ' + input.revision +
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
