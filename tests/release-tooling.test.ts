import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const run = (filename: string, ...args: string[]) =>
  execFileSync(process.execPath, [join(ROOT, 'scripts', filename), ...args], {
    cwd: ROOT, encoding: 'utf8', timeout: 30_000
  }).trim()

test('stable and release candidate semantic version tags are accepted', () => {
  assert.equal(run('prepare-release.mjs', '--validate', 'v1.2.3'), '1.2.3')
  assert.equal(run('prepare-release.mjs', '--validate', 'v0.1.0-rc.1'), '0.1.0-rc.1')
  assert.equal(run('prepare-release.mjs', '--validate', 'v2.0.0-rc.0'), '2.0.0-rc.0')
})

test('malformed tags cannot produce a release', () => {
  for (const tag of [
    'v1.2', 'v1.2.3-rc', 'v1.2.3-rc.01', 'v01.2.3', 'v1.2.3-beta.1',
    'v1.2.3+build', 'release-v1.2.3', 'v1.2.3-rc.-1', 'v1.2.3;rm -rf /'
  ]) {
    const result = spawnSync(process.execPath,
      [join(ROOT, 'scripts', 'prepare-release.mjs'), '--validate', tag],
      { cwd: ROOT, encoding: 'utf8' })
    assert.notEqual(result.status, 0, 'Invalid tag was accepted: ' + tag)
  }
})

test('generated Linux PNGs and Windows ICO have the expected structures', () => {
  const directory = mkdtempSync(join(tmpdir(), 'spindle-icons-'))
  try {
    run('generate-icons.mjs', directory)
    const png = readFileSync(join(directory, 'icons', '256x256.png'))
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
    assert.equal(png.readUInt32BE(16), 256)
    assert.equal(png.readUInt32BE(20), 256)
    const ico = readFileSync(join(directory, 'icon.ico'))
    assert.equal(ico.readUInt16LE(0), 0)
    assert.equal(ico.readUInt16LE(2), 1)
    assert.equal(ico.readUInt16LE(4), 6)
    assert.ok(readdirSync(join(directory, 'icons')).includes('512x512.png'))
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('release assets must have all platform-specific filenames', () => {
  const directory = mkdtempSync(join(tmpdir(), 'spindle-assets-'))
  const version = '0.1.0-rc.2'
  try {
    writeFileSync(join(directory, `Spindle-${version}-linux-x64.deb`), 'deb')
    writeFileSync(join(directory, `Spindle-${version}-linux-x64.AppImage`), 'appimage')
    assert.match(run('verify-release-artifacts.mjs', 'linux', version, directory), /Verified/)
    const missing = spawnSync(process.execPath,
      [join(ROOT, 'scripts', 'verify-release-artifacts.mjs'), 'all', version, directory],
      { encoding: 'utf8' })
    assert.notEqual(missing.status, 0)
    writeFileSync(join(directory, `Spindle-Setup-${version}-windows-x64.exe`), 'exe')
    assert.match(run('verify-release-artifacts.mjs', 'all', version, directory), /Verified/)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
