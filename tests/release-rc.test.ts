import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const script = join(root, 'scripts', 'validate-next-rc.mjs')

// The Release workflow stamps package.json from the tag before running tests.
// Fixtures therefore follow that source version instead of assuming 0.1.0.
// A different release line is generated explicitly for the negative case.
const sourceVersion: string = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
const [major, minor, patch] = sourceVersion.split('.').map(Number)
assert.match(sourceVersion, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/)
const otherVersion = `${major}.${minor}.${patch + 1}`
const rc = (sequence: string | number) => `v${sourceVersion}-rc.${sequence}`

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
  rc(7), rc(8),
  `v${otherVersion}-rc.99`
]

test('manual release accepts only a new monotonic RC for the source version', () => {
  const result = validate(rc(9), existing)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), `${sourceVersion}-rc.9`)

  const later = validate(rc(10), existing)
  assert.equal(later.status, 0, later.stderr)
})

test('manual release refuses existing, older and duplicate release tags', () => {
  for (const tag of [rc(7), rc(8), rc(6)]) {
    const result = validate(tag, existing)
    assert.notEqual(result.status, 0, tag)
  }
  assert.notEqual(validate(rc(9), [...existing, rc(9)]).status, 0)
})

test('stable release prevents later prerelease tags of the same version', () => {
  const result = validate(rc(9), [...existing, `v${sourceVersion}`])
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /stable release already exists/i)
})

test('manual RC validation rejects bad versions, other release lines and injection', () => {
  for (const tag of [
    'main', `v${sourceVersion}`, `v${otherVersion}-rc.9`,
    rc('09'), rc('-1'), rc('9007199254740993'),
    `${rc(9)};echo injected`, '--force', 'v1.0.0-beta.1'
  ]) {
    assert.notEqual(validate(tag, existing).status, 0, tag)
  }
})
