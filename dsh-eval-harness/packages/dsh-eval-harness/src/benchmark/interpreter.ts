import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { EnvironmentRequirement } from '../run/environment.ts'
import {
  manifestRequirements,
  manifestTaskRoot,
  renderTemplate,
  type LoadedBenchmarkManifest,
} from './manifest.ts'

/** One benchmark task materialized from a manifest. */
export interface BenchmarkTask {
  /** Stable task id (usually the directory name). */
  readonly id: string
  /** Language track, e.g. `python`. */
  readonly language: string
  /** Prompt handed to the agent, assembled from task files and the manifest template. */
  readonly prompt: string
  /** Files the agent must implement, relative to the workspace. */
  readonly solutionFiles: readonly string[]
  /** Test files used by the verifier; never placed in the agent workspace. */
  readonly testFiles: readonly string[]
  /** Entries that must not reach the agent workspace. */
  readonly exclude: readonly string[]
  /** Absolute source directory of the task in the benchmark checkout. */
  readonly exerciseDir: string
}

/** A task set loaded through a benchmark manifest. */
export interface LoadedBenchmark {
  readonly name: string
  readonly root: string
  readonly language: string
  readonly revision: string
  readonly manifestPath: string
  readonly tasks: readonly BenchmarkTask[]
  /** Environment the benchmark requires; the plugin only declares and probes it. */
  readonly environment: readonly EnvironmentRequirement[]
}

/**
 * Materialize an explicit task list through a benchmark manifest.
 *
 * The manifest supplies discovery, file naming, prompt assembly and
 * verification; this function supplies no benchmark-specific knowledge.
 * @param loaded - validated manifest and its path.
 * @param root - benchmark checkout root.
 * @param language - language track, substituted into the task root template.
 * @param taskIds - explicit task ids, in the requested order.
 * @param revision - pinned revision recorded in the run manifest.
 * @returns the loaded benchmark.
 */
export async function loadBenchmarkFromManifest(
  loaded: LoadedBenchmarkManifest,
  root: string,
  language: string,
  taskIds: readonly string[],
  revision: string,
): Promise<LoadedBenchmark> {
  if (taskIds.length === 0) throw new Error('benchmark: at least one explicit task id is required')
  const { manifest } = loaded
  const taskRoot = join(root, manifestTaskRoot(manifest, language))
  const available = new Set(
    (await readdir(taskRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name),
  )
  const tasks: BenchmarkTask[] = []
  for (const id of taskIds) {
    if (!available.has(id)) {
      throw new Error('benchmark: unknown ' + language + ' task "' + id + '" under ' + taskRoot)
    }
    const exerciseDir = join(taskRoot, id)
    const meta = JSON.parse(await readFile(join(exerciseDir, manifest.tasks.meta.file), 'utf8')) as unknown
    const solutionFiles = readStringArray(meta, manifest.tasks.meta.solutionFiles)
    const testFiles = readStringArray(meta, manifest.tasks.meta.testFiles)
    if (solutionFiles.length === 0 || testFiles.length === 0) {
      throw new Error('benchmark: task "' + id + '" declares no solution or test files')
    }
    const promptBody = await readPromptFiles(exerciseDir, manifest.prompt.files)
    const prompt = renderTemplate(manifest.prompt.template, {
      language,
      taskId: id,
      name: manifest.name,
      prompt: promptBody,
      solutionFiles: solutionFiles.join(', '),
    })
    tasks.push({
      id,
      language,
      prompt,
      solutionFiles,
      testFiles,
      exclude: [...manifest.tasks.exclude, ...testFiles],
      exerciseDir,
    })
  }
  return {
    name: manifest.name,
    root,
    language,
    revision,
    manifestPath: loaded.path,
    tasks,
    environment: manifestRequirements(manifest),
  }
}

/** Read a dotted JSON path as a string array. */
function readStringArray(value: unknown, dottedPath: string): readonly string[] {
  let current: unknown = value
  for (const key of dottedPath.split('.')) {
    if (current === null || typeof current !== 'object') return []
    current = (current as Record<string, unknown>)[key]
  }
  if (!Array.isArray(current)) return []
  return current.filter((item): item is string => typeof item === 'string' && item !== '')
}

/** Read prompt files in order; only explicitly optional files may be missing. */
async function readPromptFiles(
  taskDir: string,
  files: LoadedBenchmarkManifest['manifest']['prompt']['files'],
): Promise<string> {
  const parts: string[] = []
  for (const file of files) {
    try {
      parts.push((await readFile(join(taskDir, file.path), 'utf8')).trim())
    } catch (error) {
      if (file.optional === true) continue
      throw new Error('benchmark: prompt file ' + file.path + ' is missing in ' + taskDir + ': ' + String(error))
    }
  }
  return parts.filter((part) => part !== '').join('\n\n')
}
