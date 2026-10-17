import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { loadBenchmarkFromManifest } from '../benchmark/interpreter.ts'
import { loadManifest, manifestRequirements, manifestTaskRoot } from '../benchmark/manifest.ts'

/** Canonical output value of the `eval_manifest` tool. */
export interface EvalManifestResult {
  valid: true
  path: string
  name: string
  schema: number
  taskRoot: string
  requirements: { id: string; command: string[]; reason: string }[]
  promptFiles: string[]
  verifyCommand: string[]
  notes: string[]
  tasks?: {
    id: string
    solutionFiles: string[]
    testFiles: string[]
    promptLength: number
  }[]
}

/**
 * Build the `eval_manifest` tool: validate a declarative benchmark manifest and
 * optionally preview the tasks it materializes from a checkout.
 * @returns the registry-ready tool definition.
 */
export function createEvalManifestTool(): ToolDefinition {
  return defineTool({
    name: 'eval_manifest',
    description:
      '校验一份 benchmark 契约（manifest）：要求、prompt 组装、验证命令与环境需求。' +
      '可选传入 benchmarkRoot + tasks 预览真实物化结果（只读，不运行任务、不配置环境）。' +
      '新 benchmark 只要 manifest 校验通过即可接入，不需要改插件代码。',
    parameters: {
      manifestPath: {
        type: 'string',
        required: true,
        description: 'manifest YAML 的绝对路径',
      },
      language: { type: 'string', required: true, description: '语言轨道，用于任务根模板' },
      benchmarkRoot: {
        type: 'string',
        description: '可选：benchmark checkout 根目录，用于预览任务物化',
      },
      tasks: {
        type: 'array',
        items: { type: 'string' },
        description: '可选：显式任务列表，与 benchmarkRoot 一起用于预览',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          valid: { type: 'boolean', required: true },
          path: { type: 'string', required: true },
          name: { type: 'string', required: true },
          schema: { type: 'integer', required: true },
          taskRoot: { type: 'string', required: true },
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
          promptFiles: { type: 'array', required: true, items: { type: 'string' } },
          verifyCommand: { type: 'array', required: true, items: { type: 'string' } },
          notes: { type: 'array', required: true, items: { type: 'string' } },
          tasks: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                solutionFiles: { type: 'array', required: true, items: { type: 'string' } },
                testFiles: { type: 'array', required: true, items: { type: 'string' } },
                promptLength: { type: 'integer', required: true },
              },
            },
          },
        },
      },
      render: (_args, value): ContentBlock[] => [
        { type: 'text', text: JSON.stringify(value, null, 2) },
      ],
    },
    execute: async (args): Promise<EvalManifestResult> => {
      const input = args as {
        readonly manifestPath: string
        readonly language: string
        readonly benchmarkRoot?: string
        readonly tasks?: readonly string[]
      }
      const loaded = loadManifest(input.manifestPath)
      const { manifest } = loaded
      const base: EvalManifestResult = {
        valid: true,
        path: loaded.path,
        name: manifest.name,
        schema: manifest.schema,
        taskRoot: manifestTaskRoot(manifest, input.language),
        requirements: manifestRequirements(manifest).map((requirement) => ({
          id: requirement.id,
          command: [requirement.command, ...requirement.args],
          reason: requirement.reason,
        })),
        promptFiles: manifest.prompt.files.map((file) => file.path),
        verifyCommand: [...manifest.verify.command],
        notes: [
          'contract only: environment provisioning is left to the Harness, the agent or the user',
          'red/green verification is not run by this tool yet',
        ],
      }
      if (input.benchmarkRoot !== undefined && (input.tasks ?? []).length > 0) {
        const loadedBenchmark = await loadBenchmarkFromManifest(
          loaded,
          input.benchmarkRoot,
          input.language,
          input.tasks ?? [],
          'manifest-preview',
        )
        base.tasks = loadedBenchmark.tasks.map((task) => ({
          id: task.id,
          solutionFiles: [...task.solutionFiles],
          testFiles: [...task.testFiles],
          promptLength: task.prompt.length,
        }))
      }
      return base
    },
  })
}
