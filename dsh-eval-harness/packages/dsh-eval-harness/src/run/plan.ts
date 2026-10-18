import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

/** Confirmed evaluation identity that `eval_run` must re-validate. */
export interface PlanIdentity {
  readonly harnessProfileDir: string
  readonly harnessMode: 'profile-snapshot' | 'minimal-control'
  readonly dshVersion: string
  readonly provider: string
  readonly model: string
  readonly manifestPath: string
  readonly language: string
  readonly revision: string
  readonly tasks: readonly string[]
}

/**
 * Compute the immutable digest of a confirmed plan.
 *
 * `eval_preflight` returns it and `eval_run` recomputes it from its own inputs,
 * so a changed profile, model, manifest or task list is detected before any
 * model call is spent.
 * @param identity - resolved plan identity.
 * @returns SHA-256 hex digest.
 */
export function planDigest(identity: PlanIdentity): string {
  const canonical = {
    harnessProfileDir: resolve(identity.harnessProfileDir),
    harnessMode: identity.harnessMode,
    dshVersion: identity.dshVersion,
    provider: identity.provider,
    model: identity.model,
    manifestPath: resolve(identity.manifestPath),
    language: identity.language,
    revision: identity.revision,
    tasks: [...identity.tasks],
  }
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}
