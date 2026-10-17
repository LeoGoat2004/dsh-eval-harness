import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'

/** One explicit model target resolved from a DSH profile's provider rows. */
export interface ModelTarget {
  /** Profile directory the provider configuration was read from. */
  readonly harnessProfile: string
  /** Provider route id, e.g. `siliconflow`. */
  readonly provider: string
  /** Model id served by that route, e.g. `Qwen/Qwen3-8B`. */
  readonly model: string
  /** Wire protocol, when the profile pins one. */
  readonly api: string | undefined
  /** Endpoint the profile pins, when present. */
  readonly baseURL: string | undefined
  /** Environment variable holding the credential. */
  readonly apiKeyEnv: string
  /** Whether the profile's provider entry lists this exact model id. */
  readonly listed: boolean
}

interface PatchRow {
  readonly id?: string
  readonly name?: string
  readonly config?: {
    readonly apiKeyEnv?: string
    readonly api?: string
    readonly baseURL?: string
    readonly models?: readonly { readonly id?: string }[]
    readonly providers?: Record<
      string,
      {
        readonly apiKeyEnv?: string
        readonly api?: string
        readonly baseURL?: string
        readonly models?: readonly { readonly id?: string }[]
      }
    >
  }
}

/**
 * Resolve the model target from a DSH profile's patch layer. The plugin does
 * not invent provider details: it reads the provider row the user already
 * configured (e.g. `llm-pi-ai` → `siliconflow` → `Qwen/Qwen3-8B`) and copies
 * that entry into the isolated eval profile.
 * @param profileDir - profile directory containing `cordis.patch.yml`.
 * @param provider - provider route id.
 * @param model - model id on that route.
 * @returns resolved model target.
 */
export function resolveModelTarget(profileDir: string, provider: string, model: string): ModelTarget {
  const patchPath = join(profileDir, 'cordis.patch.yml')
  if (!existsSync(patchPath)) {
    throw new Error('model target: profile patch not found: ' + patchPath)
  }
  const layers = parse(readFileSync(patchPath, 'utf8'))
  const rows = Array.isArray(layers) ? (layers as PatchRow[]) : []
  const piAiRow = rows.find((row) => (row.name ?? row.id ?? '').includes('dsh-llm-pi-ai'))
  const deepseekRow = rows.find((row) => (row.name ?? '') === '@deepseek-ai/dsh-llm-deepseek-api-key')

  if (provider === 'deepseek-official') {
    const apiKeyEnv = deepseekRow?.config?.apiKeyEnv
    if (apiKeyEnv === undefined) {
      throw new Error('model target: profile does not configure a DeepSeek API key environment')
    }
    return {
      harnessProfile: profileDir,
      provider,
      model,
      api: undefined,
      baseURL: deepseekRow?.config?.baseURL,
      apiKeyEnv,
      listed: true,
    }
  }

  const entry = piAiRow?.config?.providers?.[provider]
  if (entry === undefined) {
    const available = Object.keys(piAiRow?.config?.providers ?? {})
    throw new Error(
      'model target: provider "' + provider + '" is not configured in ' + patchPath +
        (available.length === 0 ? '' : ' (available: ' + available.join(', ') + ')'),
    )
  }
  if (entry.apiKeyEnv === undefined) {
    throw new Error('model target: provider "' + provider + '" has no apiKeyEnv in ' + patchPath)
  }
  const modelIds = (entry.models ?? []).map((item) => item.id ?? '').filter((id) => id !== '')
  // The user may explicitly evaluate a model the profile does not catalog
  // (e.g. a sibling Qwen build). Keep going and record `listed: false`; the
  // caller surfaces it so the choice is visible instead of silent.
  return {
    harnessProfile: profileDir,
    provider,
    model,
    api: entry.api,
    baseURL: entry.baseURL,
    apiKeyEnv: entry.apiKeyEnv,
    listed: modelIds.length === 0 || modelIds.includes(model),
  }
}
