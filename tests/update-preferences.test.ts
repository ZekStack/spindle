import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UpdatePreferencesStore, validateUpdatePreferences } from '../src/main/update-preferences'
import { isEligibleUpdate } from '../src/shared/update-policy'

function fixture(run: (store: UpdatePreferencesStore, path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'spindle-preferences-'))
  try {
    const file = join(dir, 'update-preferences.json')
    run(new UpdatePreferencesStore(file), file)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('defaults to stable for stable installs and RC for RC installs without persisting until changed', () => {
  fixture((store, file) => {
    assert.deepEqual(store.load(false), { includePrereleases: false })
    assert.deepEqual(store.load(true), { includePrereleases: true })
    assert.throws(() => readFileSync(file, 'utf8'), { code: 'ENOENT' })
  })
})

test('update channel persists across application restarts', () => {
  fixture((store, file) => {
    assert.deepEqual(store.save({ includePrereleases: true }), { includePrereleases: true })
    assert.deepEqual(new UpdatePreferencesStore(file).load(false), { includePrereleases: true })
    assert.deepEqual(store.save({ includePrereleases: false }), { includePrereleases: false })
    assert.deepEqual(new UpdatePreferencesStore(file).load(true), { includePrereleases: false })
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).version, 1)
  })
})

test('invalid IPC data and corrupt settings cannot enable prerelease updates or replace user data', () => {
  fixture((store, file) => {
    for (const invalid of [null, true, false, {}, { includePrereleases: 'true' }, { includePrereleases: 1 }]) {
      assert.throws(() => validateUpdatePreferences(invalid), /Invalid update preferences/)
      assert.throws(() => store.save(invalid), /Invalid update preferences/)
    }
    writeFileSync(file, '{"version":42,"includePrereleases":true}')
    assert.throws(() => store.load(), /Invalid update preferences file/)
    assert.throws(() => store.save({ includePrereleases: false }))
    assert.equal(readFileSync(file, 'utf8'), '{"version":42,"includePrereleases":true}')
    writeFileSync(file, 'not-json')
    assert.throws(() => store.load())
    assert.throws(() => store.save({ includePrereleases: true }))
    assert.equal(readFileSync(file, 'utf8'), 'not-json')
  })
})

test('RC opt-in permits newer RCs from stable but never older prereleases or downgrades', () => {
  assert.equal(isEligibleUpdate('0.1.2', '0.1.3-rc.1'), false)
  assert.equal(isEligibleUpdate('0.1.2', '0.1.3-rc.1', true), true)
  assert.equal(isEligibleUpdate('0.1.2', '0.1.0-rc.9', true), false)
  assert.equal(isEligibleUpdate('0.1.2', '0.1.3', false), true)
  assert.equal(isEligibleUpdate('0.1.3-rc.1', '0.1.3-rc.2'), true)
  assert.equal(isEligibleUpdate('0.1.3-rc.1', '0.1.3-rc.2', false), false)
  assert.equal(isEligibleUpdate('0.1.3-rc.1', '0.1.3', false), true)
  assert.equal(isEligibleUpdate('0.1.3', '0.1.3-rc.2', true), false)
  assert.equal(isEligibleUpdate('0.1.3-rc.2', '0.1.3-rc.1', true), false)
})
