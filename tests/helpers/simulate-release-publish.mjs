import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { publishRelease } from '../../scripts/publish-release.mjs'
import { expectedFiles } from '../../scripts/verify-release-artifacts.mjs'

const tag = 'v0.1.0-rc.6'
const version = '0.1.0-rc.6'
const repository = 'ExampleOrg/spindle'
const dir = mkdtempSync(join(tmpdir(), 'spindle-publish-'))
const names = [...expectedFiles('all', version),
  'latest.yml', 'latest-linux.yml', 'SHA256SUMS.txt', 'installer.blockmap']
const digest = (path) => 'sha256:' + createHash('sha256').update(readFileSync(path)).digest('hex')
const localAsset = (name) => {
  const file = join(dir, name)
  return { name, size: statSync(file).size, digest: digest(file), state: 'uploaded' }
}

function mockGithub(options = {}) {
  const release = {
    exists: Boolean(options.exists),
    draft: options.published ? false : true,
    prerelease: Boolean(options.published),
    assets: new Map()
  }
  const calls = []
  let createFailure = Boolean(options.createFailure)
  let uploadFailure = options.uploadFailure || null
  let readFailure = options.readFailure || null

  const gh = async (args) => {
    calls.push([...args])
    if (args[0] === 'api') {
      assert.deepEqual(args, ['api', 'repos/' + repository + '/releases/tags/' + tag])
      if (readFailure) {
        const failure = readFailure
        readFailure = null
        throw new Error('HTTP ' + failure)
      }
      if (!release.exists) throw new Error('HTTP 404: Not Found')
      return JSON.stringify({
        draft: release.draft, prerelease: release.prerelease,
        assets: [...release.assets.values()]
      })
    }
    assert.equal(args[0], 'release')
    const operation = args[1]
    if (operation === 'create') {
      release.exists = true
      assert.ok(args.includes('--draft'))
      if (createFailure) {
        createFailure = false
        throw new Error('HTTP 500 after draft creation')
      }
      return ''
    }
    if (operation === 'upload') {
      const file = args[3]
      const asset = localAsset(file.split(/[\\/]/).at(-1))
      if (uploadFailure === 'forbidden') throw new Error('HTTP 403')
      if (uploadFailure === 'before-accept') {
        uploadFailure = null
        throw new Error('HTTP 500 before asset accepted')
      }
      release.assets.set(asset.name, asset)
      if (uploadFailure === 'after-accept') {
        uploadFailure = null
        throw new Error('HTTP 500 after asset accepted')
      }
      return ''
    }
    if (operation === 'edit') {
      assert.ok(args.includes('--draft=false'))
      assert.ok(args.includes('--latest=false'))
      release.draft = false
      release.prerelease = args.includes('--prerelease=true')
      return ''
    }
    throw new Error('Unexpected gh command: ' + args.join(' '))
  }
  return { gh, release, calls }
}

const sleep = async () => {}
const publish = (client) => publishRelease(
  { tag, prerelease: true, directory: dir, repository },
  { gh: client.gh, sleep }
)
const uploads = (client) => client.calls.filter((args) => args[1] === 'upload')
const creates = (client) => client.calls.filter((args) => args[1] === 'create')

try {
  for (const name of [...names, 'builder-debug.yml']) {
    writeFileSync(join(dir, name), 'asset contents: ' + name)
  }

  const transient = mockGithub({ createFailure: true, uploadFailure: 'after-accept' })
  await publish(transient)
  assert.equal(transient.release.draft, false)
  assert.equal(transient.release.prerelease, true)
  assert.deepEqual([...transient.release.assets.keys()].sort(), [...names].sort())
  assert.equal(uploads(transient).length, names.length,
    '500 after successful upload must not upload the file twice')
  assert.ok(!transient.release.assets.has('builder-debug.yml'))
  for (const asset of transient.release.assets.values()) {
    assert.equal(asset.digest, localAsset(asset.name).digest)
  }

  await publish(transient)
  assert.equal(uploads(transient).length, names.length,
    'rerunning an identical published release must not mutate its assets')

  const beforeAccepted = mockGithub({ uploadFailure: 'before-accept' })
  await publish(beforeAccepted)
  assert.equal(beforeAccepted.release.assets.size, names.length)
  assert.equal(uploads(beforeAccepted).length, names.length + 1)

  const denied = mockGithub({ uploadFailure: 'forbidden' })
  await assert.rejects(() => publish(denied), /403/)
  assert.equal(denied.release.draft, true, 'failed upload must stay in draft')

  const deniedRead = mockGithub({ readFailure: '403' })
  await assert.rejects(() => publish(deniedRead), /403/)
  assert.equal(creates(deniedRead).length, 0,
    '403 on release lookup must not be treated as missing release')

  const recoveredRead = mockGithub({ readFailure: '500' })
  await publish(recoveredRead)
  assert.equal(creates(recoveredRead).length, 1,
    'transient release lookup must be retried instead of creating duplicate')

  const wrongDigest = mockGithub({ exists: true })
  for (const name of names) wrongDigest.release.assets.set(name, localAsset(name))
  wrongDigest.release.assets.set(names[0], {
    ...localAsset(names[0]), digest: 'sha256:' + '0'.repeat(64)
  })
  await publish(wrongDigest)
  assert.equal(uploads(wrongDigest).length, 1,
    'matching filename and size with wrong checksum must be replaced in a draft')
  assert.equal(wrongDigest.release.assets.get(names[0]).digest, localAsset(names[0]).digest)

  const publishedConflict = mockGithub({ exists: true, published: true })
  for (const name of names) publishedConflict.release.assets.set(name, localAsset(name))
  publishedConflict.release.assets.set(names[0], {
    ...localAsset(names[0]), digest: 'sha256:' + '0'.repeat(64)
  })
  await assert.rejects(() => publish(publishedConflict), /incorrect release asset/)
  assert.equal(uploads(publishedConflict).length, 0,
    'a published release must never be overwritten by a retry')

  await assert.rejects(() => publishRelease(
    { tag, prerelease: false, directory: dir, repository },
    { gh: transient.gh, sleep }
  ), /channel/)

  console.log('Release publication: SHA-256 verification, 404/403/500 handling, ' +
    'resumable drafts, immutable published assets and RC channel tests passed')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
