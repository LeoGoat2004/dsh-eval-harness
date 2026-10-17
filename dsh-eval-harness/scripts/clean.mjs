// Remove build output only, and only for a plain directory (never for a link).
import { existsSync, lstatSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { BUNDLE_DIR } from './registry.mjs'

const lib = join(BUNDLE_DIR, 'lib')
if (!existsSync(lib)) process.exit(0)

const stat = lstatSync(lib)
if (!stat.isDirectory() || stat.isSymbolicLink()) {
  console.error('clean: refusing to delete non-plain directory ' + lib)
  process.exit(1)
}
rmSync(lib, { recursive: true, force: true })
console.log('[clean] ' + lib)
