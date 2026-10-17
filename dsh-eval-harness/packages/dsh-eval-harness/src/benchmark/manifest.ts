import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import type { EnvironmentRequirement } from '../run/environment.ts'

/**
 * Declarative benchmark contract.
 *
 * A manifest describes *what* a benchmark needs and *how* it is judged. It
 * never describes environment provisioning: the plugin probes
 * `environment.requirements` and hands the decision of how to satisfy them to
 * the Harness/agent/user. New benchmarks are added by adding a manifest, not by
 * editing plugin code.
 */
export interface BenchmarkManifest {
  readonly schema: 1
  readonly name: string
  /** Declarative task discovery. */
  readonly tasks: {
    readonly discovery: 'directory'
    /** Directory template; `{{language}}` is replaced with the run's language. */
    readonly root: string
    /** Where per-task metadata lives and which JSON fields name the files. */
    readonly meta: {
      readonly file: string
      readonly solutionFiles: string
      readonly testFiles: string
    }
    /** Entries that must not reach the agent workspace. */
    readonly exclude: readonly string[]
  }
  /** How the prompt is assembled from task files plus a wrapper template. */
  readonly prompt: {
    /** Ordered prompt files; `optional: true` files may be missing. */
    readonly files: readonly { readonly path: string; readonly optional?: boolean }[]
    readonly template: string
  }
  /** How the benchmark verifies a workspace. */
  readonly verify: {
    readonly command: readonly string[]
    readonly result: 'junitxml'
  }
  /** Optional official reference used for green verification. */
  readonly reference?: {
    /** Reference file inside the task directory. */
    readonly file: string
    /** Where the reference is copied: first solution file or every solution file. */
    readonly target: 'solutionFiles[0]' | 'allSolutionFiles'
  }
  /**
   * Where an episode runs. Omitted means `host` (the historical behaviour).
   * `container` never provisions an image: the environment must provide it, and
   * the preflight reports a missing image instead of building one.
   */
  readonly execution?: {
    readonly kind: 'host' | 'container'
    readonly container?: {
      /** Container image (templated per task); provided by the environment. */
      readonly image: string
      /** Container path of the agent workspace. */
      readonly workspace: string
      /** Container path where the raw trace directory is mounted (default `/trace`). */
      readonly tracePath?: string
      /** Mount the host task workspace into `workspace` (default true). */
      readonly mountWorkspace?: boolean
      /** Extra mounts (templated). `source` is a host path. */
      readonly mounts?: readonly { readonly source: string; readonly target: string; readonly readOnly?: boolean }[]
      /** Container environment (templated; `{{env:NAME}}` reads the host env). */
      readonly env?: readonly { readonly name: string; readonly value: string }[]
      /** Agent command inside the container (templated). */
      readonly agentCommand: readonly string[]
      /** Grading command inside the same container (templated). */
      readonly verifyCommand: readonly string[]
    }
  }
  /** Requirements the environment must satisfy; the plugin only probes them. */
  readonly environment: {
    readonly requirements: readonly EnvironmentRequirement[]
  }
}

/** A manifest plus the absolute path it was loaded from. */
export interface LoadedBenchmarkManifest {
  readonly path: string
  readonly manifest: BenchmarkManifest
}

const MANIFEST_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'presets')

/**
 * Load and validate one benchmark manifest.
 * @param path - absolute path of the manifest file.
 * @returns the validated manifest and its path.
 */
export function loadManifest(path: string): LoadedBenchmarkManifest {
  if (!existsSync(path)) throw new Error('manifest: file not found: ' + path)
  let parsed: unknown
  try {
    parsed = parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error('manifest: not valid YAML: ' + String(error))
  }
  return { path, manifest: validateManifest(parsed, path) }
}

/**
 * Locate a manifest shipped with the package.
 * @param name - preset name, e.g. `aider-polyglot`.
 * @returns absolute path of the preset manifest.
 */
export function builtinManifestPath(name: string): string {
  return join(MANIFEST_DIR, name + '.yml')
}

/**
 * Substitute `{{key}}` placeholders in one template string.
 * @param template - template with placeholders.
 * @param vars - placeholder values.
 * @returns the rendered string.
 */
export function renderTemplate(template: string, vars: Readonly<Record<string, string>>): string {
  return template.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/gu, (match, key: string) =>
    key in vars ? (vars[key] as string) : match,
  )
}

/** Task root for a language track, with `{{language}}` substituted. */
export function manifestTaskRoot(manifest: BenchmarkManifest, language: string): string {
  return renderTemplate(manifest.tasks.root, { language })
}

/** Environment requirements declared by the manifest. */
export function manifestRequirements(manifest: BenchmarkManifest): readonly EnvironmentRequirement[] {
  return manifest.environment.requirements
}

function validateManifest(value: unknown, path: string): BenchmarkManifest {
  if (value === null || typeof value !== 'object') {
    throw new Error('manifest(' + path + '): root must be a mapping')
  }
  const root = value as Record<string, unknown>
  if (root.schema !== 1) throw new Error('manifest(' + path + '): schema must be 1')
  const name = requireString(root.name, 'name')
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(name)) {
    throw new Error('manifest(' + path + '): name must be lower-kebab-case')
  }
  const tasks = requireObject(root.tasks, 'tasks')
  if (tasks.discovery !== 'directory') {
    throw new Error('manifest(' + path + '): tasks.discovery must be "directory"')
  }
  const tasksRoot = requireString(tasks.root, 'tasks.root')
  if (!tasksRoot.includes('{{language}}')) {
    throw new Error('manifest(' + path + '): tasks.root must contain {{language}} so one manifest serves every track')
  }
  const meta = requireObject(tasks.meta, 'tasks.meta')
  const prompt = requireObject(root.prompt, 'prompt')
  const promptFiles = requireArray(prompt.files, 'prompt.files').map((item, index): { path: string; optional?: boolean } => {
    const entry = requireObject(item, 'prompt.files[' + String(index) + ']')
    const optional = entry.optional === true ? { optional: true } : {}
    return { path: requireString(entry.path, 'prompt.files[' + String(index) + '].path'), ...optional }
  })
  const template = requireString(prompt.template, 'prompt.template')
  if (!template.includes('{{prompt}}')) {
    throw new Error('manifest(' + path + '): prompt.template must contain {{prompt}}')
  }
  if (!template.includes('{{solutionFiles}}')) {
    throw new Error('manifest(' + path + '): prompt.template must contain {{solutionFiles}}')
  }
  const verify = requireObject(root.verify, 'verify')
  const command = requireStringArray(verify.command, 'verify.command')
  if (!command.some((part) => part.includes('{{testFiles}}'))) {
    throw new Error('manifest(' + path + '): verify.command must reference {{testFiles}}')
  }
  if (verify.result !== 'junitxml') {
    throw new Error('manifest(' + path + '): verify.result must be "junitxml"')
  }
  const environment = requireObject(root.environment, 'environment')
  const requirements = requireArray(environment.requirements, 'environment.requirements').map(
    (item, index): EnvironmentRequirement => {
      const requirement = requireObject(item, 'environment.requirements[' + String(index) + ']')
      const kind = optionalKind(requirement.kind, 'environment.requirements[' + String(index) + '].kind')
      return {
        id: requireString(requirement.id, 'environment.requirements[' + String(index) + '].id'),
        ...(kind === undefined ? {} : { kind }),
        command: requireString(requirement.command, 'environment.requirements[' + String(index) + '].command'),
        args: requireStringArray(requirement.args, 'environment.requirements[' + String(index) + '].args'),
        reason: requireString(requirement.reason, 'environment.requirements[' + String(index) + '].reason'),
      }
    },
  )
  const ids = new Set(requirements.map((requirement) => requirement.id))
  if (ids.size !== requirements.length) {
    throw new Error('manifest(' + path + '): requirement ids must be unique')
  }
  const reference = validateReference(root.reference, path)
  const execution = validateExecution(root.execution, path)
  return {
    schema: 1,
    name,
    tasks: {
      discovery: 'directory',
      root: tasksRoot,
      meta: {
        file: requireString(meta.file, 'tasks.meta.file'),
        solutionFiles: requireString(meta.solutionFiles, 'tasks.meta.solutionFiles'),
        testFiles: requireString(meta.testFiles, 'tasks.meta.testFiles'),
      },
      exclude: requireStringArray(tasks.exclude, 'tasks.exclude'),
    },
    prompt: { files: promptFiles, template },
    verify: { command, result: 'junitxml' },
    ...(reference === undefined ? {} : { reference }),
    ...(execution === undefined ? {} : { execution }),
    environment: { requirements },
  }
}

/** Validate the optional execution block; container mode stays declarative. */
function validateExecution(value: unknown, path: string): BenchmarkManifest['execution'] {
  if (value === undefined) return undefined
  const execution = requireObject(value, 'execution')
  if (execution.kind !== 'host' && execution.kind !== 'container') {
    throw new Error('manifest(' + path + '): execution.kind must be host or container')
  }
  if (execution.kind === 'host') {
    if (execution.container !== undefined) {
      throw new Error('manifest(' + path + '): execution.container is only valid with kind container')
    }
    return { kind: 'host' }
  }
  const container = requireObject(execution.container, 'execution.container')
  const mounts = container.mounts === undefined
    ? undefined
    : requireArray(container.mounts, 'execution.container.mounts').map((item, index) => {
        const mount = requireObject(item, 'execution.container.mounts[' + String(index) + ']')
        return {
          source: requireString(mount.source, 'execution.container.mounts[' + String(index) + '].source'),
          target: requireString(mount.target, 'execution.container.mounts[' + String(index) + '].target'),
          ...(mount.readOnly === true ? { readOnly: true } : {}),
        }
      })
  const env = container.env === undefined
    ? undefined
    : requireArray(container.env, 'execution.container.env').map((item, index) => {
        const entry = requireObject(item, 'execution.container.env[' + String(index) + ']')
        return {
          name: requireString(entry.name, 'execution.container.env[' + String(index) + '].name'),
          value: requireString(entry.value, 'execution.container.env[' + String(index) + '].value'),
        }
      })
  return {
    kind: 'container',
    container: {
      image: requireString(container.image, 'execution.container.image'),
      workspace: requireString(container.workspace, 'execution.container.workspace'),
      ...(container.tracePath === undefined
        ? {}
        : { tracePath: requireString(container.tracePath, 'execution.container.tracePath') }),
      ...(container.mountWorkspace === undefined
        ? {}
        : { mountWorkspace: container.mountWorkspace === true }),
      ...(mounts === undefined ? {} : { mounts }),
      ...(env === undefined ? {} : { env }),
      agentCommand: requireStringArray(container.agentCommand, 'execution.container.agentCommand'),
      verifyCommand: requireStringArray(container.verifyCommand, 'execution.container.verifyCommand'),
    },
  }
}

/** Validate the optional green-verification reference block. */
function validateReference(
  value: unknown,
  path: string,
): { file: string; target: 'solutionFiles[0]' | 'allSolutionFiles' } | undefined {
  if (value === undefined) return undefined
  const reference = requireObject(value, 'reference')
  if (reference.target !== 'solutionFiles[0]' && reference.target !== 'allSolutionFiles') {
    throw new Error('manifest(' + path + '): reference.target must be solutionFiles[0] or allSolutionFiles')
  }
  return { file: requireString(reference.file, 'reference.file'), target: reference.target }
}

const REQUIREMENT_KINDS = new Set<string>([
  'executable',
  'module',
  'container-runtime',
  'container-image',
  'network',
  'other',
])

function optionalKind(value: unknown, field: string): EnvironmentRequirement['kind'] | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !REQUIREMENT_KINDS.has(value)) {
    throw new Error('manifest: ' + field + ' must be one of ' + [...REQUIREMENT_KINDS].join(', '))
  }
  return value as EnvironmentRequirement['kind']
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('manifest: ' + field + ' must be a mapping')
  }
  return value as Record<string, unknown>
}

function requireArray(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('manifest: ' + field + ' must be a non-empty array')
  }
  return value
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('manifest: ' + field + ' must be a non-empty string')
  }
  return value
}

function requireStringArray(value: unknown, field: string): readonly string[] {
  return requireArray(value, field).map((item, index) => requireString(item, field + '[' + String(index) + ']'))
}
