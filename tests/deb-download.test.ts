import test from 'node:test'
import assert from 'node:assert/strict'
import { DebInstallError } from '../src/main/deb-install'
import { selectDownloadedDeb } from '../src/main/deb-download'

const version = '0.1.0-rc.6'
const name = `Spindle-${version}-linux-x64.deb`
const appImage = `Spindle-${version}-linux-x64.AppImage`
const file = `/home/user/.cache/spindle-updater/pending/${name}`
const digest = 'A'.repeat(86) + '=='
const files = [
  { url: appImage, sha512: 'B'.repeat(86) + '==' },
  { url: name, sha512: digest }
]

function rejectsNonDeb(data: Parameters<typeof selectDownloadedDeb>[0]): void {
  assert.throws(() => selectDownloadedDeb(data), (error) =>
    error instanceof DebInstallError && error.reason === 'verification')
}

test('selects the exact DEB metadata even when AppImage appears first', () => {
  assert.deepEqual(selectDownloadedDeb({ version, files, downloadedFile: file }),
    { version, file, sha512: digest })
})

test('rejects an AppImage download before any privileged installation', () => {
  rejectsNonDeb({ version, files, downloadedFile: `/tmp/${appImage}` })
  rejectsNonDeb({ version, files, downloadedFile: undefined })
})

test('requires a unique DEB file and a valid checksum', () => {
  rejectsNonDeb({ version, files: files.slice(0, 1), downloadedFile: file })
  rejectsNonDeb({ version, files: [...files, files[1]], downloadedFile: file })
  rejectsNonDeb({ version, files: [{ url: name, sha512: 'invalid' }], downloadedFile: file })
  rejectsNonDeb({ version, files: [{ url: 'Different.deb', sha512: digest }], downloadedFile: file })
})

test('accepts release URLs with URL-encoded filenames and query strings', () => {
  assert.deepEqual(selectDownloadedDeb({
    version, downloadedFile: file,
    files: [{ url: 'https://github.com/ZekStack/spindle/releases/download/v0.1.0-rc.6/' +
      encodeURIComponent(name) + '?token=test', sha512: digest }]
  }), { version, file, sha512: digest })
})
