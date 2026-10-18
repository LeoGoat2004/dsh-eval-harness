import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadBenchmarkFromManifest } from '../packages/dsh-eval-harness/src/benchmark/interpreter.ts'
import { loadManifest } from '../packages/dsh-eval-harness/src/benchmark/manifest.ts'

/** Build a benchmark fixture with the given prompt path and task meta. */
function fixture(options: { promptPath?: string; meta?: string }): { root: string; manifestPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-eval-paths-'))
  const taskDir = join(root, 'node', 't1')
  mkdirSync(taskDir, { recursive: true })
  writeFileSync(join(taskDir, 'prompt.md'), 'prompt')
  if (options.meta !== undefined) {
    mkdirSync(join(taskDir, '.meta'), { recursive: true })
    writeFileSync(join(taskDir, '.meta', 'config.json'), options.meta)
  }
  const manifestPath = join(root, 'manifest.yml')
  writeFileSync(
    manifestPath,
    [
      'schema: 1',
      'name: path-fixture',
      'tasks:',
      '  discovery: directory',
      '  root: "{{language}}"',
      ...(options.meta === undefined
        ? []
        : [
            '  meta:',
            '    file: .meta/config.json',
            '    solutionFiles: files.solution',
            '    testFiles: files.test',
          ]),
      '  exclude: []',
      'prompt:',
      '  files:',
      '    - path: ' + (options.promptPath ?? 'prompt.md'),
      '  template: "{{prompt}}{{solutionFiles}}"',
      'verify:',
      '  command: [node, -e, "process.exit(0)", "{{testFiles}}"]',
      '  result: junitxml',
      'environment:',
      '  requirements:',
      '    - id: node',
      '      command: node',
      '      args: [--version]',
      '      reason: fixture',
      '',
    ].join('\n'),
  )
  return { root, manifestPath }
}

describe('benchmark path safety', () => {
  it('rejects a prompt path that escapes the task directory', () => {
    const { manifestPath } = fixture({ promptPath: '../escape.md' })
    expect(() => loadManifest(manifestPath)).toThrow('must not contain ".."')
  })

  it('rejects an absolute prompt path', () => {
    const { manifestPath } = fixture({ promptPath: '/etc/passwd' })
    expect(() => loadManifest(manifestPath)).toThrow('must be a relative path')
  })

  it('rejects task metadata that points outside the task directory', async () => {
    const { root, manifestPath } = fixture({
      meta: JSON.stringify({ files: { solution: ['../escape.py'], test: ['test.py'] } }),
    })
    const loaded = loadManifest(manifestPath)
    await expect(loadBenchmarkFromManifest(loaded, root, 'node', ['t1'], 'self-check')).rejects.toThrow(
      'must not contain ".."',
    )
  })
})
