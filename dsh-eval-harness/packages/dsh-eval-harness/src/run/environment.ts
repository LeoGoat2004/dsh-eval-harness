import { spawnSync } from 'node:child_process'

/** Declared environment requirements for a benchmark and their probe results. */

/** What kind of environment capability a requirement describes. */
export type EnvironmentRequirementKind =
  | 'executable'
  | 'module'
  | 'container-runtime'
  | 'container-image'
  | 'network'
  | 'other'

/** One requirement a benchmark declares about the environment it runs in. */
export interface EnvironmentRequirement {
  /** Stable id used in manifests and the dashboard. */
  readonly id: string
  /** Requirement category; defaults to `executable` for legacy manifests. */
  readonly kind?: EnvironmentRequirementKind
  /** Probe executable. */
  readonly command: string
  /** Probe arguments; the probe succeeds when the process exits 0. */
  readonly args: readonly string[]
  /** Why the benchmark needs this, shown when the probe fails. */
  readonly reason: string
}

/** Result of probing one requirement. */
export interface EnvironmentProbe {
  readonly id: string
  readonly ok: boolean
  /** First non-empty line of probe output, or the spawn error. */
  readonly detail: string
}

/**
 * Probe the environment the plugin process runs in. The plugin never installs
 * anything: a failure means the user must configure the environment first, and
 * the message says exactly what is missing.
 * @param requirements - requirements declared by the benchmark adapter.
 * @returns one probe result per requirement, in declaration order.
 */
export function probeRequirements(requirements: readonly EnvironmentRequirement[]): EnvironmentProbe[] {
  return requirements.map((requirement) => {
    const result = spawnSync(requirement.command, [...requirement.args], {
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
    })
    const output = firstLine(result.stdout) ?? firstLine(result.stderr) ?? ''
    if (result.error !== undefined) {
      return { id: requirement.id, ok: false, detail: String(result.error) }
    }
    const ok = result.status === 0
    return {
      id: requirement.id,
      ok,
      detail: ok ? output : requirement.reason + '（检测命令退出 ' + String(result.status) + '）' + (output === '' ? '' : ' ' + output),
    }
  })
}

function firstLine(text: string | null | undefined): string | null {
  if (text === null || text === undefined) return null
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (trimmed !== '') return trimmed.slice(0, 200)
  }
  return null
}
