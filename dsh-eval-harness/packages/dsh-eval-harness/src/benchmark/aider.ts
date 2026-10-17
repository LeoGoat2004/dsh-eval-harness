import type { EnvironmentRequirement } from '../run/environment.ts'
import { loadBenchmarkFromManifest, type BenchmarkTask, type LoadedBenchmark } from './interpreter.ts'
import { builtinManifestPath, loadManifest, manifestRequirements } from './manifest.ts'

/** Backward-compatible task alias; every adapter materializes this shape. */
export type AiderTask = BenchmarkTask

/** Backward-compatible benchmark result used by the runner and scripts. */
export type AiderBenchmark = LoadedBenchmark

/**
 * Built-in Aider polyglot manifest, loaded once for requirement discovery and
 * for callers that still use the historical loader name.
 */
const AIDER_MANIFEST = loadManifest(builtinManifestPath('aider-polyglot'))

/** Environment requirements declared by the built-in Aider manifest. */
export const AIDER_PYTHON_ENVIRONMENT: readonly EnvironmentRequirement[] = manifestRequirements(
  AIDER_MANIFEST.manifest,
)

/**
 * Load explicitly requested Aider polyglot exercises through the declarative
 * manifest. Kept as a named wrapper because the pipeline and offline tools use
 * this entry point; the logic itself lives in the manifest interpreter.
 * @param root - benchmark checkout root.
 * @param language - language track, e.g. `python`.
 * @param taskIds - explicit exercise ids in the requested order.
 * @param revision - pinned git revision recorded in the run manifest.
 * @returns the loaded benchmark with tasks in the requested order.
 */
export async function loadAiderBenchmark(
  root: string,
  language: string,
  taskIds: readonly string[],
  revision: string,
): Promise<AiderBenchmark> {
  return loadBenchmarkFromManifest(AIDER_MANIFEST, root, language, taskIds, revision)
}

/**
 * Entries that must never reach the agent workspace: the manifest's excludes
 * plus this task's test files.
 * @param task - the task being materialized.
 * @returns relative paths to skip when seeding the workspace.
 */
export function workspaceExcludes(task: AiderTask): ReadonlySet<string> {
  return new Set(task.exclude)
}
