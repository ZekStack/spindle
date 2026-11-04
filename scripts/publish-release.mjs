import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { parseReleaseTag } from './prepare-release.mjs'
import { expectedFiles } from './verify-release-artifacts.mjs'

const execFileAsync = promisify(execFile)
const wait = (ms) => new Promise((done) => setTimeout(done, ms))
const RETRIES = 5

async function github(args) {
  const { stdout } = await execFileAsync('gh', args, {
    timeout: 240_000,
    maxBuffer: 1024 * 1024,
    encoding: 'utf8'
  })
  return stdout.trim()
}

function transient(error) {
  const message = error instanceof Error ? error.message : String(error)
  return /\b(?:429|500|502|503|504)\b|ECONNRESET|ETIMEDOUT|timeout|temporary|rate limit/i.test(message)
}

function isNotFound(error) {
  const message = error instanceof Error ? error.message : String(error)
  return /\bHTTP\s+404\b|\bNot Found\s+\(HTTP\s+404\)|\bno release found for\b|\brelease not found\b/i.test(message)
}

async function retry(label, task, sleep) {
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try { return await task() }
    catch (error) {
      if (!transient(error) || attempt === RETRIES) throw error
      console.warn(label + ': transient GitHub error, attempt ' + attempt + '/' + RETRIES)
      await sleep(2 ** attempt * 1000)
    }
  }
  throw new Error(label + ' exceeded retries')
}

async function sha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return 'sha256:' + hash.digest('hex')
}

async function localAssets(directory, version) {
  const names = await readdir(directory)
  const required = [...expectedFiles('all', version),
    'latest.yml', 'latest-linux.yml', 'SHA256SUMS.txt']
  const optional = names.filter((name) => name.endsWith('.blockmap')).sort()
  const selected = [...required, ...optional]
  const entries = []
  for (const name of selected) {
    if (!names.includes(name)) throw new Error('Missing release asset: ' + name)
    const file = join(directory, name)
    const info = await stat(file)
    if (!info.isFile() || info.size === 0) throw new Error('Invalid release asset: ' + name)
    entries.push({ name, file, size: info.size, digest: await sha256(file) })
  }
  return entries
}

async function releaseDetails(gh, repository, tag) {
  // The REST /releases/tags/{tag} endpoint is for *published* releases.
  // gh release view can resolve drafts with write access, giving the
  // numeric release ID. Fetch that ID through REST for SHA-256 digests.
  const view = JSON.parse(await gh(['release', 'view', tag, '--json', 'apiUrl']))
  const uri = new URL(view.apiUrl)
  const expected = '/repos/' + repository + '/releases/'
  if (uri.protocol !== 'https:' || uri.hostname !== 'api.github.com' ||
      uri.username || uri.password || uri.port || uri.search || uri.hash ||
      !uri.pathname.toLowerCase().startsWith(expected.toLowerCase()) ||
      !/^\d+$/.test(uri.pathname.slice(expected.length))) {
    throw new Error('Unexpected GitHub release API URL')
  }
  const raw = await gh(['api', uri.pathname.slice(1)])
  const data = JSON.parse(raw)
  if (!Array.isArray(data.assets) ||
      typeof data.draft !== 'boolean' || typeof data.prerelease !== 'boolean' ||
      data.tag_name !== tag) {
    throw new Error('GitHub returned incomplete or mismatched release details')
  }
  return data
}

async function optionalRelease(gh, repository, tag, sleep) {
  try {
    return await retry('Reading GitHub Release',
      () => releaseDetails(gh, repository, tag), sleep)
  } catch (error) {
    if (isNotFound(error)) return null
    // A 401/403, transient outage, or malformed response is not a missing
    // release. Never attempt to create a duplicate in those situations.
    throw error
  }
}

function matches(remote, local) {
  return remote && remote.name === local.name &&
    remote.state === 'uploaded' &&
    remote.size === local.size && remote.digest === local.digest
}

function verifyExactAssets(details, assets) {
  const expected = new Map(assets.map((item) => [item.name, item]))
  for (const asset of assets) {
    if (!matches(details.assets.find((item) => item.name === asset.name), asset)) {
      throw new Error('temporary missing or incorrect release asset: ' + asset.name)
    }
  }
  for (const remote of details.assets) {
    if (!expected.has(remote.name)) {
      throw new Error('Unexpected release asset: ' + remote.name)
    }
  }
}

/**
 * Draft-first, resumable publication. Digest verification prevents a same-size
 * but different binary from being incorrectly accepted after an API 500.
 * Published releases are never silently modified on rerun.
 */
export async function publishRelease(
  { tag, prerelease, directory, repository = process.env.GH_REPO },
  { gh = github, sleep = wait } = {}
) {
  const { version, prerelease: tagIsPrerelease } = parseReleaseTag(tag)
  if (prerelease !== tagIsPrerelease) throw new Error('Release channel does not match the tag')
  if (typeof repository !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repository)) {
    throw new Error('GH_REPO must identify exactly one owner/repository')
  }
  const assets = await localAssets(resolve(directory), version)
  let details = await optionalRelease(gh, repository, tag, sleep)

  if (details && !details.draft) {
    // Reruns are safe only when all existing published bytes are identical.
    verifyExactAssets(details, assets)
    if (details.prerelease !== prerelease) {
      throw new Error('Published release has a different release channel')
    }
    console.log('Already published and verified: ' + tag)
    return
  }

  if (!details) {
    for (let attempt = 1; attempt <= RETRIES; attempt++) {
      try {
        await gh(['release', 'create', tag, '--verify-tag', '--draft',
          '--title', 'Spindle ' + tag, '--generate-notes'])
      } catch (error) {
        // A failed create response may follow a successfully created draft.
        details = await optionalRelease(gh, repository, tag, sleep)
        if (details) break
        if (!transient(error) || attempt === RETRIES) throw error
        await sleep(2 ** attempt * 1000)
        continue
      }
      details = await optionalRelease(gh, repository, tag, sleep)
      if (details) break
    }
    if (!details || !details.draft) {
      throw new Error('GitHub did not create an accessible draft release')
    }
  }

  for (const asset of assets) {
    for (let attempt = 1; attempt <= RETRIES; attempt++) {
      details = await retry('Reading draft assets',
        () => releaseDetails(gh, repository, tag), sleep)
      if (!details.draft) throw new Error('Release became public during upload')
      const remote = details.assets.find((item) => item.name === asset.name)
      if (matches(remote, asset)) {
        console.log('Already uploaded and verified: ' + asset.name)
        break
      }
      try {
        // A mismatched draft asset is replaced, but published assets never are.
        await gh(['release', 'upload', tag, asset.file, '--clobber'])
      } catch (error) {
        if (!transient(error) || attempt === RETRIES) throw error
        console.warn('Upload retry needed for ' + asset.name + ', attempt ' + attempt)
        await sleep(2 ** attempt * 1000)
        continue
      }
      break
    }
  }

  await retry('Verifying release assets', async () => {
    const result = await releaseDetails(gh, repository, tag)
    if (!result.draft) throw new Error('Release became public before final verification')
    verifyExactAssets(result, assets)
  }, sleep)

  const editArgs = ['release', 'edit', tag, '--draft=false',
    '--prerelease=' + prerelease]
  if (prerelease) editArgs.push('--latest=false')
  await retry('Publishing release', () => gh(editArgs), sleep)

  const published = await retry('Checking published release',
    () => releaseDetails(gh, repository, tag), sleep)
  if (published.draft || published.prerelease !== prerelease) {
    throw new Error('Release publication state is inconsistent')
  }
  verifyExactAssets(published, assets)
  console.log('Published ' + tag + ' with ' + assets.length + ' SHA-256 verified assets')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [tag, channel, directory] = process.argv.slice(2)
  if (!tag || !['true', 'false'].includes(channel) || !directory) {
    console.error('Usage: node scripts/publish-release.mjs TAG true|false DIR')
    process.exitCode = 2
  } else {
    publishRelease({ tag, prerelease: channel === 'true', directory })
      .catch((error) => {
        console.error('Release publishing failed:',
          error instanceof Error ? error.message : String(error))
        process.exitCode = 1
      })
  }
}
