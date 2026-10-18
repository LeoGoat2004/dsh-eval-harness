/** Dashboard generation facade: the generator ships with the plugin package. */

/** Outcome of writing one standalone dashboard. */
export interface DashboardResult {
  readonly dashboard: string
  readonly bytes: number
  readonly tasks: number
  readonly findings: number
}

/**
 * Generate the standalone dashboard for one completed run.
 * @param runDir - absolute run directory.
 * @param options - optional template override (development checkout).
 * @returns written file path plus summary counters.
 */
export async function generateDashboard(
  runDir: string,
  options: { readonly templatePath?: string } = {},
): Promise<DashboardResult> {
  const url = new URL('../../assets/dashboard/generate.mjs', import.meta.url).href
  const module = (await import(url)) as {
    generateDashboard: (directory: string, overrides?: { readonly templatePath?: string }) => DashboardResult
  }
  return module.generateDashboard(runDir, options)
}
