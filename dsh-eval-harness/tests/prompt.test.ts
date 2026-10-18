import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runEpisode } from '../packages/dsh-eval-harness/src/run/profile.ts'

/** Stub launcher that records its argv and exits cleanly. */
const STUB = `
import { writeFileSync } from 'node:fs'
writeFileSync(process.env.CAPTURE_PATH, JSON.stringify(process.argv.slice(2)))
process.exit(0)
`

describe('prompt passthrough', () => {
  it('passes the manifest prompt to the agent byte-for-byte', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-eval-prompt-'))
    const stub = join(root, 'stub.mjs')
    const capture = join(root, 'argv.json')
    writeFileSync(stub, STUB)
    const prompt = 'line one\nline "two" — 中文\n\n## Heading\n`code`'
    const result = await runEpisode({
      dshBin: stub,
      dshHome: join(root, 'home'),
      profileName: 'unit',
      overlayPath: join(root, 'overlay.yml'),
      workspaceDir: root,
      traceDir: join(root, 'trace'),
      prompt,
      env: { ...process.env, CAPTURE_PATH: capture },
      timeoutMs: 10_000,
      limits: { maxSteps: 100, maxIdenticalToolCalls: 10 },
    })
    expect(result.exitCode).toBe(0)
    const argv = JSON.parse(readFileSync(capture, 'utf8')) as string[]
    // argv: --profile unit --patch overlay <prompt>
    expect(argv.at(-1)).toBe(prompt)
  })
})
