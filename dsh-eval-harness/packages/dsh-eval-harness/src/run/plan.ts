import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** Confirmed evaluation identity that `eval_run` must re-validate. */
export interface PlanInputs {
  readonly harnessProfileDir: string
  readonly harnessMode: 'profile-snapshot' | 'minimal-control'
  readonly dshVersion: string
  readonly provider: string
  readonly model: string
  readonly api?: string
  readonly baseURL?: string
  readonly apiKeyEnv: string
  readonly manifestPath: string
  readonly benchmarkRoot: string
  readonly language: string
  readonly revision: string
  readonly tasks: readonly string[]
}

/** Content-addressed plan: everything that changes what the experiment is. */
export interface PlanContent {
  readonly schema: 2
  readonly harness: {
    readonly profileDir: string
    readonly mode: string
    readonly dshVersion: string
    readonly files: Readonly<Record<string, string | null>>
    readonly digest: string
  }
  readonly model: {
    readonly provider: string
    readonly model: string
    readonly api: string | null
    readonly baseURL: string | null
    readonly apiKeyEnv: string
  }
  readonly manifest: { readonly path: string; readonly sha256: string }
  readonly benchmark: {
    readonly root: string
    readonly gitAvailable: boolean
    readonly head: string | null
    readonly dirty: boolean | null
  }
  readonly language: string
  readonly revision: string
  readonly tasks: readonly string[]
}

const PROFILE_FILES = ['package.json', 'cordis.yml', 'cordis.patch.yml', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']

/**
 * Collect the content-addressed plan used by preflight and run.
 *
 * Unlike a label-only digest, this covers the manifest bytes, the confirmed
 * profile's configuration/lockfiles, the benchmark checkout state and the
 * non-secret model route. Changing any of them changes the digest and a run
 * started with the old digest is refused.
 * @param input - resolved confirmation inputs.
 * @returns plan content with a stable digest field.
 */
export function collectPlanContent(input: PlanInputs): PlanContent {
  const profileDir = resolve(input.harnessProfileDir)
  const files: Record<string, string | null> = {}
  for (const name of PROFILE_FILES) {
    const path = join(profileDir, name)
    files[name] = existsSync(path) ? sha256(readFileSync(path, 'utf8')) : null
  }
  const harnessDigest = sha256(JSON.stringify({ mode: input.harnessMode, dshVersion: input.dshVersion, files }))
  const manifestSha256 = sha256(readFileSync(resolve(input.manifestPath), 'utf8'))
  const git = readGitState(resolve(input.benchmarkRoot))
  return {
    schema: 2,
    harness: {
      profileDir,
      mode: input.harnessMode,
      dshVersion: input.dshVersion,
      files,
      digest: harnessDigest,
    },
    model: {
      provider: input.provider,
      model: input.model,
      api: input.api ?? null,
      baseURL: input.baseURL ?? null,
      apiKeyEnv: input.apiKeyEnv,
    },
    manifest: { path: resolve(input.manifestPath), sha256: manifestSha256 },
    benchmark: {
      root: resolve(input.benchmarkRoot),
      gitAvailable: git.available,
      head: git.head ?? null,
      dirty: git.dirty ?? null,
    },
    language: input.language,
    revision: input.revision,
    tasks: [...input.tasks],
  }
}

/** SHA-256 of the canonical plan content. */
export function planDigest(content: PlanContent): string {
  return sha256(JSON.stringify(content))
}

/** Convenience: collect and digest in one step. */
export function digestPlan(input: PlanInputs): string {
  return planDigest(collectPlanContent(input))
}

/** SHA-256 hex digest of one string. */
function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** Read a git checkout's HEAD and dirty state; tolerant of non-repositories. */
function readGitState(root: string): { available: boolean; head?: string; dirty?: boolean } {
  try {
    const head = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true })
    if (head.status !== 0 || typeof head.stdout !== 'string' || head.stdout.trim() === '') return { available: false }
    const status = spawnSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8', windowsHide: true })
    return {
      available: true,
      head: head.stdout.trim(),
      dirty: status.status === 0 && typeof status.stdout === 'string' ? status.stdout.trim() !== '' : undefined,
    }
  } catch {
    return { available: false }
  }
}
