import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { chooseDebAsset } from '../src/main/deb-feed'
import { detectLinuxPackage } from '../src/main/package-type'
import { DebInstallError } from '../src/main/deb-install'

const version = '0.1.0-rc.6'
const name = `Spindle-${version}-linux-x64.deb`
const hash = 'A'.repeat(86) + '=='
const files = [
  { url: `Spindle-${version}-linux-x64.AppImage`, sha512: 'B'.repeat(86) + '==' },
  { url: name, sha512: hash },
]

test('Debian feed filters to exactly the DEB before updater download', () => {
  const selected = chooseDebAsset({ version, files })
  assert.equal(selected.url, name)
  assert.equal(selected.sha512, hash)
  assert.notEqual(selected, files[0])
})

test('stable and RC metadata select the corresponding exact DEB', () => {
  const stable = '0.2.0'
  const rcFile = `Spindle-${stable}-linux-x64.deb`
  assert.equal(chooseDebAsset({
    version: stable,
    files: [{ url: `Spindle-${stable}-linux-x64.AppImage`, sha512: hash },
      { url: rcFile, sha512: hash }],
  }).url, rcFile)
})

test('no fallback to AppImage, foreign version, or ambiguous packages', () => {
  for (const candidates of [
    files.slice(0, 1),
    [{ url: `Spindle-${version}-linux-x64.AppImage`, sha512: hash }],
    [{ url: 'SomeOther-0.1.0-rc.6-linux-x64.deb', sha512: hash }],
    [{ url: 'Spindle-0.1.0-rc.5-linux-x64.deb', sha512: hash }],
    [files[1], files[1]],
    [{ url: name, sha512: 'not-a-real-hash' }],
  ]) {
    assert.throws(() => chooseDebAsset({ version, files: candidates }), (error) =>
      error instanceof DebInstallError && error.reason === 'verification')
  }
})

test('GitHub URLs with encoded names and query parameters are supported', () => {
  const selected = chooseDebAsset({
    version,
    files: [{ url: 'https://github.com/ZekStack/spindle/releases/download/v0.1.0-rc.6/' +
      encodeURIComponent(name) + '?credential=unused', sha512: hash }],
  })
  assert.equal(selected.sha512, hash)
})

test('detect Linux package type only from actual packaged marker or APPIMAGE', () => {
  const temp = mkdtempSync(join(tmpdir(), 'spindle-format-'))
  try {
    assert.equal(detectLinuxPackage(temp, ''), 'unknown')
    writeFileSync(join(temp, 'package-type'), 'deb\n')
    assert.equal(detectLinuxPackage(temp, ''), 'deb')
    assert.equal(detectLinuxPackage(temp, '/tmp/Spindle.AppImage'), 'appimage')
    writeFileSync(join(temp, 'package-type'), 'rpm\n')
    assert.equal(detectLinuxPackage(temp, ''), 'unknown')
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})
