import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import {
  parseReleaseVersion, isPrereleaseVersion, isNewerRelease, updateErrorMessage
} from '../src/shared/update-policy'
import { fileURLToPath } from 'node:url'

test('stable and release candidate versions are compared without downgrades', () => {
  assert.deepEqual(parseReleaseVersion('v0.1.0-rc.2'),
    { major: 0, minor: 1, patch: 0, rc: 2 })
  assert.equal(isPrereleaseVersion('0.1.0-rc.1'), true)
  assert.equal(isPrereleaseVersion('0.1.0'), false)
  assert.equal(isNewerRelease('0.1.0-rc.1', '0.1.0-rc.2'), true)
  assert.equal(isNewerRelease('0.1.0-rc.2', '0.1.0'), true)
  assert.equal(isNewerRelease('0.1.0', '0.1.0-rc.3'), false)
  assert.equal(isNewerRelease('0.1.0', '0.2.0-rc.1'), true)
  assert.equal(isNewerRelease('0.2.0-rc.1', '0.1.9'), false)
  assert.equal(isNewerRelease('1.0.0', '1.0.0'), false)
  assert.equal(isNewerRelease('1.0.0', '1.0.1'), true)
  assert.equal(isNewerRelease('1.9.0', '2.0.0'), true)
})

test('invalid release versions never become installable', () => {
  for (const candidate of ['1.1', '1.1.0-beta.1', 'v01.0.0', 'v1.0.0-rc.01',
    '1.0.0+meta', '1.0.0-rc.-1', '1.0.0;rm -rf /', '1.0.0-rc.a', '']) {
    assert.equal(parseReleaseVersion(candidate), null)
    assert.equal(isNewerRelease('0.1.0', candidate), false)
  }
})

test('update error details cannot leak tokens to the UI', () => {
  const message = updateErrorMessage(new Error('HTTP 401 Authorization: token ghp-secret-value'))
  assert.match(message, /GitHub/)
  assert.equal(message.includes('ghp-secret-value'), false)
  assert.match(updateErrorMessage(new Error('sha512 mismatch')), /verification/i)
})

test('release metadata must contain every platform artifact and SHA-512', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spindle-update-feeds-'))
  const sha = 'A'.repeat(88)
  function verify(platform: string): void {
    const script = fileURLToPath(new URL('../scripts/verify-update-metadata.mjs', import.meta.url))
    const result = spawnSync(process.execPath, [script, platform, '0.2.0-rc.1', dir], { encoding: 'utf8' })
    if (result.status !== 0) throw new Error(result.stderr || result.stdout)
  }
  try {
    writeFileSync(join(dir, 'latest.yml'),
      'version: 0.2.0-rc.1\nfiles:\n  - url: Spindle-Setup-0.2.0-rc.1-windows-x64.exe\n    sha512: ' + sha + '\n')
    writeFileSync(join(dir, 'latest-linux.yml'),
      'version: 0.2.0-rc.1\nfiles:\n  - url: Spindle-0.2.0-rc.1-linux-x64.AppImage\n    sha512: ' + sha + '\n' +
      '  - url: Spindle-0.2.0-rc.1-linux-x64.deb\n    sha512: ' + sha + '\n')
    assert.doesNotThrow(() => verify('all'))
    assert.doesNotThrow(() => verify('linux'))
    assert.doesNotThrow(() => verify('windows'))
    writeFileSync(join(dir, 'latest-linux.yml'),
      'version: 0.2.0-rc.1\nfiles:\n  - url: Spindle-0.2.0-rc.1-linux-x64.AppImage\n    sha512: ' + sha + '\n')
    assert.throws(() => verifyUpdateMetadata('all', '0.2.0-rc.1', dir), /missing installer/i)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
