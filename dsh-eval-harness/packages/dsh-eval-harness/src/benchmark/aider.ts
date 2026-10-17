import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { EnvironmentRequirement } from '../run/environment.ts'

/** One materialized Aider polyglot task. */
export interface AiderTask {
  /** Stable exercise id, e.g. `two-bucket`. */
  readonly id: string
  /** Language track, e.g. `python`. */
  readonly language: string
  /** Exercise text handed to the agent (instructions + append fix). */
  readonly prompt: string
  /** Solution files the agent must implement, relative to the workspace. */
  readonly solutionFiles: readonly string[]
  /** Test files used by the verifier; never placed in the agent workspace. */
  readonly testFiles: readonly string[]
  /** Absolute source directory of the exercise in the benchmark checkout. */
  readonly exerciseDir: string
}

/** A loaded Aider polyglot task set. */
export interface AiderBenchmark {
  readonly name: 'aider-polyglot'
  readonly root: string
  readonly language: string
  readonly revision: string
  readonly tasks: readonly AiderTask[]
  /** Environment the adapter requires; the plugin only declares and probes it. */
  readonly environment: readonly EnvironmentRequirement[]
}

/**
 * Aider's Python track needs a Python runtime and pytest for the verifier.
 * The plugin never installs them: a missing requirement fails preflight with
 * this reason so the user can configure the environment first.
 */
export const AIDER_PYTHON_ENVIRONMENT: readonly EnvironmentRequirement[] = [
  {
    id: 'python',
    command: 'python',
    args: ['--version'],
    reason: 'Aider Python tasks need a Python runtime in the evaluation environment',
  },
  {
    id: 'pytest',
    command: 'python',
    args: ['-m', 'pytest', '--version'],
    reason: 'The benchmark verifier runs pytest',
  },
]

/** Shape of `.meta/config.json` that this adapter relies on. */
interface ExerciseConfig {
  readonly files?: {
    readonly solution?: readonly string[]
    readonly test?: readonly string[]
  }
}

const EXCLUDED_DIRECTORIES = new Set(['.meta', '.docs', '.approaches'])

/**
 * Load exactly the requested exercises from an Aider polyglot checkout.
 * Task ids are explicit: the adapter never widens or defaults the task set.
 * @param root - benchmark checkout root.
 * @param language - language track directory, e.g. `python`.
 * @param taskIds - explicit exercise ids in the order the caller wants.
 * @param revision - pinned git revision recorded in the run manifest.
 * @returns the loaded benchmark with tasks in the requested order.
 */
export async function loadAiderBenchmark(
  root: string,
  language: string,
  taskIds: readonly string[],
  revision: string,
): Promise<AiderBenchmark> {
  if (taskIds.length === 0) throw new Error('benchmark adapter: at least one explicit task id is required')
  const practice = join(root, language, 'exercises', 'practice')
  const available = new Set(
    (await readdir(practice, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name),
  )
  const tasks: AiderTask[] = []
  for (const id of taskIds) {
    if (!available.has(id)) {
      throw new Error('benchmark adapter: unknown ' + language + ' exercise "' + id + '" under ' + practice)
    }
    const exerciseDir = join(practice, id)
    const config = JSON.parse(await readFile(join(exerciseDir, '.meta', 'config.json'), 'utf8')) as ExerciseConfig
    const solutionFiles = config.files?.solution ?? []
    const testFiles = config.files?.test ?? []
    if (solutionFiles.length === 0 || testFiles.length === 0) {
      throw new Error('benchmark adapter: ' + id + ' declares no solution or test files')
    }
    tasks.push({
      id,
      language,
      prompt: await readPrompt(exerciseDir),
      solutionFiles,
      testFiles,
      exerciseDir,
    })
  }
  return {
    name: 'aider-polyglot',
    root,
    language,
    revision,
    tasks,
    environment: language === 'python' ? AIDER_PYTHON_ENVIRONMENT : [],
  }
}

/**
 * Read the exercise prompt: instructions plus the track's append fix when present.
 * @param exerciseDir - exercise source directory.
 * @returns the combined prompt text.
 */
async function readPrompt(exerciseDir: string): Promise<string> {
  const docs = join(exerciseDir, '.docs')
  const parts = [await readFile(join(docs, 'instructions.md'), 'utf8')]
  try {
    parts.push(await readFile(join(docs, 'instructions.append.md'), 'utf8'))
  } catch {
    // The append file is optional.
  }
  return parts.join('\n\n').trim()
}

/**
 * Directories and files that must never reach the agent workspace (answers and metadata).
 * @param task - the task being materialized.
 * @returns relative paths to skip when seeding the workspace.
 */
export function workspaceExcludes(task: AiderTask): ReadonlySet<string> {
  const excludes = new Set<string>(EXCLUDED_DIRECTORIES)
  for (const file of task.testFiles) excludes.add(file)
  return excludes
}
