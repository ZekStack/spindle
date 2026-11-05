import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const script = join(root, 'scripts', 'validate-next-rc.mjs')

function validate(tag: string, existingTags: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'spindle-rc-'))
  try {
    const tagsFile = join(dir, 'tags.txt')
    writeFileSync(tagsFile, existingTags.join('\n') + '\n')
    return spawnSync(process.execPath, [script, tag, tagsFile], {
      cwd: root, encoding: 'utf8', timeout: 30_000
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const existing = [
  'v0.1.0-rc.7', 'v0.1.0-rc.8',
  'v0.0.9', 'v0.0.9-rc.99'
]

test('manual release accepts only a new monotonic RC for the source version', () => {
  const result = validate('v0.1.0-rc.9', existing)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), '0.1.0-rc.9')

  const later = validate('v0.1.0-rc.10', existing)
  assert.equal(later.status, 0, later.stderr)
})

test('manual release refuses existing, older and duplicate release tags', () => {
  for (const tag of ['v0.1.0-rc.7', 'v0.1.0-rc.8', 'v0.1.0-rc.6']) {
    const result = validate(tag, existing)
    assert.notEqual(result.status, 0, tag)
  }
  assert.notEqual(validate('v0.1.0-rc.9', [...existing, 'v0.1.0-rc.9']).status, 0)
})

test('stable release prevents later prerelease tags of the same version', () => {
  const result = validate('v0.1.0-rc.9', [...existing, 'v0.1.0'])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /stable release already exists/i)
})

test('manual RC validation rejects bad versions, other release lines and injection', () => {
  for (const tag of [
    'main', 'v0.1.0', 'v0.2.0-rc.1', 'v0.1.1-rc.9', 'v1.0.0-rc.1',
    'v0.1.0-rc.09', 'v0.1.0-rc.-1', 'v0.1.0-rc.9007199254740993',
    'v0.1.0-rc.9;echo injected', '--force'
  ]) {
    assert.notEqual(validate(tag, existing).status, 0, tag)
  }
})
