import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadManifest } from '../packages/dsh-eval-harness/src/benchmark/manifest.ts'

/** Write one manifest fixture and load it. */
function load(containerLines: readonly string[]) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-eval-manifest-'))
  const path = join(root, 'manifest.yml')
  writeFileSync(
    path,
    [
      'schema: 1',
      'name: container-fixture',
      'tasks:',
      '  discovery: directory',
      '  root: "{{language}}"',
      '  exclude: []',
      'prompt:',
      '  files:',
      '    - path: prompt.md',
      '  template: "{{prompt}}"',
      'environment:',
      '  requirements:',
      '    - id: docker',
      '      command: docker',
      '      args: [--version]',
      '      reason: container execution',
      'execution:',
      '  kind: container',
      '  container:',
      ...containerLines,
      '',
    ].join('\n'),
  )
  return loadManifest(path).manifest
}

const base = [
  '    image: "example/image:tag"',
  '    workspace: /workspace',
  '    agentCommand: [bash, -lc, "true"]',
  '    verifyCommand: [bash, -lc, "true"]',
]

describe('container manifest fields', () => {
  it('parses verifier-only env and artifacts separately from agent env', () => {
    const manifest = load([
      ...base,
      '    artifacts: [/app]',
      '    env:',
      '      - name: AGENT_TOKEN',
      '        value: "{{runEnv:TOKEN}}"',
      '    verifyEnv:',
      '      - name: TEST_DIR',
      '        value: /tests',
    ])
    const container = manifest.execution?.container
    expect(container?.artifacts).toEqual(['/app'])
    expect(container?.env?.[0]?.name).toBe('AGENT_TOKEN')
    expect(container?.verifyEnv?.[0]?.name).toBe('TEST_DIR')
  })

  it('parses separate images and agent/verifier mounts', () => {
    const manifest = load([
      ...base,
      '    agentImage: "agent:1"',
      '    verifierImage: "verifier:1"',
      '    agentMounts:',
      '      - source: /agent-data',
      '        target: /agent',
      '    verifierMounts:',
      '      - source: /grader',
      '        target: /grader',
      '        readOnly: true',
    ])
    const container = manifest.execution?.container
    expect(container?.agentImage).toBe('agent:1')
    expect(container?.verifierImage).toBe('verifier:1')
    expect(container?.agentMounts?.[0]?.target).toBe('/agent')
    expect(container?.verifierMounts?.[0]?.readOnly).toBe(true)
  })

  it('rejects malformed artifacts', () => {
    expect(() => load([...base, '    artifacts: [123]'])).toThrow('execution.container.artifacts')
  })
})
