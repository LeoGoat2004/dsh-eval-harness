// Single source of truth for the bundle package and the rows its patch inserts.
// Row ids are frozen once used; the bundle package name is frozen because the
// profile dependency bookkeeping keys on it.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Absolute path of the plugin workspace root. */
export const WORKSPACE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** Directory holding the bundle package. */
export const PACKAGES_DIR = join(WORKSPACE_ROOT, 'packages')

/** Bundle package name (frozen). The bundle package is also the plugin. */
export const BUNDLE_PKG = 'dsh-eval-harness'

/** Absolute directory of the bundle package. */
export const BUNDLE_DIR = join(PACKAGES_DIR, BUNDLE_PKG)

/**
 * Rows the bundle patch inserts. Every row mounts this same package; extra rows
 * exist only when one package exposes several subpath entries.
 */
export const ROWS = [
  {
    id: 'eval-harness-run',
    /** Plugin identity exported by the module this row mounts. */
    plugin: 'eval-harness-run',
  },
]

/** Read and parse one JSON file. */
export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** Read one UTF-8 text file. */
export function readText(path) {
  return readFileSync(path, 'utf8')
}
