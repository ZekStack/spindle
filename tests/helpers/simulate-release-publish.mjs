import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { publishRelease } from '../../scripts/publish-release.mjs'
import { expectedFiles } from '../../scripts/verify-release-artifacts.mjs'

const tag = 'v0.1.0-rc.6'
const version = '0.1.0-rc.6'
const dir = mkdtempSync(join(tmpdir(), 'spindle-publish-'))
const names = [...expectedFiles('all', version),
  'latest.yml', 'latest-linux.yml', 'SHA256SUMS.txt', 'installer.blockmap']

function mockGithub(options = {}) {
  const release = { exists: false, isDraft: true, isPrerelease: false, assets: new Map() }
  const calls = []
  let createFailure = Boolean(options.createFailure)
  let uploadFailure = options.uploadFailure || null
  const gh = async (args) => {
    calls.push([...args])
    assert.equal(args[0], 'release')
    const method = args[1]
    if (method === 'view') {
      if (!release.exists) throw new Error('HTTP 404 release not found')
      return JSON.stringify({ isDraft: release.isDraft, isPrerelease: release.isPrerelease,
        assets: Array.from(release.assets, ([name, size]) => ({ name, size })) })
    }
    if (method === 'create') {
      release.exists = true
      assert.ok(args.includes('--draft'))
      if (createFailure) {
        createFailure = false
        throw new Error('HTTP 500 after creating a draft')
      }
      return ''
    }
    if (method === 'upload') {
      const filename = args[3]
      const name = filename.split(/[\\/]/).at(-1)
      if (uploadFailure === 'forbidden') throw new Error('HTTP 403')
      const size = statSync(filename).size
      if (uploadFailure === 'before-accept') {
        uploadFailure = null
        throw new Error('HTTP 500 before upload accepted')
      }
      release.assets.set(name, size)
      if (uploadFailure === 'after-accept') {
        uploadFailure = null
        throw new Error('HTTP 500 after upload accepted')
      }
      return ''
    }
    if (method === 'edit') {
      release.isDraft = false
      release.isPrerelease = args.includes('--prerelease=true')
      assert.ok(args.includes('--latest=false'))
      return ''
    }
    throw new Error('Unexpected gh call: ' + args.join(' '))
  }
  return { gh, release, calls }
}
const sleep = async () => {}

try {
  for (const name of [...names, 'builder-debug.yml']) {
    writeFileSync(join(dir, name), 'nonempty file content: ' + name)
  }

  const transient = mockGithub({ createFailure: true, uploadFailure: 'after-accept' })
  await publishRelease({ tag, prerelease: true, directory: dir }, { gh: transient.gh, sleep })
  assert.equal(transient.release.isDraft, false)
  assert.equal(transient.release.isPrerelease, true)
  assert.deepEqual(Array.from(transient.release.assets.keys()).sort(), names.sort())
  assert.ok(!transient.release.assets.has('builder-debug.yml'))
  const uploaded = transient.calls.filter((args) => args[1] === 'upload').length
  assert.equal(uploaded, names.length, '5xx after acceptance must not duplicate assets')

  await publishRelease({ tag, prerelease: true, directory: dir }, { gh: transient.gh, sleep })
  assert.equal(transient.calls.filter((args) => args[1] === 'upload').length, uploaded,
    'rerun must not re-upload matching assets')

  const beforeAccepted = mockGithub({ uploadFailure: 'before-accept' })
  await publishRelease({ tag, prerelease: true, directory: dir }, { gh: beforeAccepted.gh, sleep })
  assert.equal(beforeAccepted.release.assets.size, names.length)
  assert.equal(beforeAccepted.calls.filter((args) => args[1] === 'upload').length, names.length + 1)

  const denied = mockGithub({ uploadFailure: 'forbidden' })
  await assert.rejects(() => publishRelease(
    { tag, prerelease: true, directory: dir },
    { gh: denied.gh, sleep }
  ), /403/)
  assert.equal(denied.release.isDraft, true, 'failed uploads must leave draft unpublished')

  await assert.rejects(() => publishRelease(
    { tag, prerelease: false, directory: dir },
    { gh: denied.gh, sleep }
  ), /channel/)
  console.log('Release publisher retry, resumability, channel and draft safety tests passed')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
