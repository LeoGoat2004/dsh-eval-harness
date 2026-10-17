import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'

/** One static observation about the environment a profile would build. */
export interface HarnessAuditCheck {
  readonly id: string
  readonly ok: boolean
  readonly detail: string
}

/** Static isolation audit of one DSH profile's own patch layer. */
export interface HarnessAudit {
  readonly profileDir: string
  readonly clean: boolean
  readonly checks: readonly HarnessAuditCheck[]
  /** What this audit cannot see (bundle-internal rows, credentials content). */
  readonly notes: readonly string[]
}

interface PatchRow {
  readonly id?: string
  readonly name?: string
  readonly disabled?: boolean
  readonly config?: Record<string, unknown>
}

/**
 * Audit whether a profile would pull host-local skills, instruction files or
 * credentials into an evaluated episode. This is a static view of the profile's
 * patch layer only: rows shipped by bundles are invisible until the profile is
 * dumped, and credential values are never read.
 * @param profileDir - profile directory containing `cordis.patch.yml`.
 * @returns audit checks with a clean flag.
 */
export function auditHarnessProfile(profileDir: string): HarnessAudit {
  const checks: HarnessAuditCheck[] = []
  const notes = [
    'static view of the profile patch layer only; bundle default rows are not inspected',
    'this audit reports risks, it never changes the profile',
  ]
  const patchPath = join(profileDir, 'cordis.patch.yml')
  if (!existsSync(patchPath)) {
    return {
      profileDir,
      clean: false,
      checks: [{ id: 'profile-patch', ok: false, detail: 'cordis.patch.yml not found: ' + patchPath }],
      notes,
    }
  }
  const rows = readRows(patchPath)
  const byName = (needle: string): PatchRow | undefined =>
    rows.find((row) => (row.name ?? row.id ?? '').includes(needle))
  const enabled = (needle: string): PatchRow | undefined => {
    const row = byName(needle)
    return row !== undefined && row.disabled !== true ? row : undefined
  }

  const toolSkill = enabled('dsh-tool-skill')
  checks.push({
    id: 'skill-loader',
    ok: toolSkill === undefined,
    detail:
      toolSkill === undefined
        ? 'no enabled skill loader row'
        : 'skill loader is enabled; host or bundled skills may be loaded into episodes',
  })
  const skillFilesystem = enabled('dsh-skill-filesystem')
  const skillRootsIsolated =
    skillFilesystem === undefined || skillFilesystem.config?.includeDefaultRoots === false
  checks.push({
    id: 'skill-filesystem',
    ok: skillRootsIsolated,
    detail:
      skillFilesystem === undefined
        ? 'skill filesystem provider is not enabled in this layer'
        : skillRootsIsolated
          ? 'default skill roots are disabled'
          : 'default skill roots are enabled; ~/.agents/skills and project skills may be scanned',
  })
  const instructions = enabled('dsh-agent-instructions')
  const instructionsDisabled = instructions?.config?.maxBytes === 0
  checks.push({
    id: 'instruction-files',
    ok: instructions === undefined || instructionsDisabled,
    detail:
      instructions === undefined
        ? 'instruction loader is not enabled in this layer'
        : instructionsDisabled
          ? 'instruction discovery is disabled'
          : 'instruction discovery may read user/project AGENTS.md',
  })
  const credentials = enabled('dsh-credentials-local')
  checks.push({
    id: 'credentials',
    ok: credentials === undefined,
    detail:
      credentials === undefined
        ? 'host credential store is not enabled in this layer'
        : 'host credential store is enabled; provider keys may come from the user home',
  })
  const approval = enabled('dsh-authorization')
  checks.push({
    id: 'authorization',
    ok: approval === undefined,
    detail:
      approval === undefined
        ? 'authorization provider is not enabled in this layer'
        : 'authorization provider is enabled; approval behaviour depends on the host',
  })
  return { profileDir, clean: checks.every((check) => check.ok), checks, notes }
}

function readRows(patchPath: string): PatchRow[] {
  try {
    const parsed = parse(readFileSync(patchPath, 'utf8'))
    return Array.isArray(parsed) ? (parsed as PatchRow[]) : []
  } catch {
    return []
  }
}
