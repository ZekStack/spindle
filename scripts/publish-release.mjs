import { execFile } from 'node:child_process'
import { readdir, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { parseReleaseTag } from './prepare-release.mjs'
import { expectedFiles } from './verify-release-artifacts.mjs'

const execFileAsync = promisify(execFile)
const wait = (ms) => new Promise((done) => setTimeout(done, ms))
const RETRIES = 5

/** gh is used only in CI; the GITHUB_TOKEN stays in the job environment. */
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

async function retry(label, task, sleep) {
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try { return await task() }
    catch (error) {
      if (!transient(error) || attempt === RETRIES) throw error
      const delay = 2 ** attempt * 1000
      console.warn(`${label} hit a temporary GitHub failure (attempt ${attempt}/${RETRIES}); retrying`)
      await sleep(delay)
    }
  }
  throw new Error(`${label} exceeded retries`)
}

async function localAssets(dir, version) {
  const names = await readdir(dir)
  const mandatory = [
    ...expectedFiles('all', version),
    'latest.yml',
    'latest-linux.yml',
    'SHA256SUMS.txt'
  ]
  const optional = names.filter((name) => name.endsWith('.blockmap')).sort()
  const selected = [...mandatory, ...optional]
  const entries = []
  for (const name of selected) {
    if (!names.includes(name)) throw new Error(`Missing release asset ${name}`)
    const file = join(dir, name)
    const info = await stat(file)
    if (!info.isFile() || info.size === 0) throw new Error(`Invalid release asset ${name}`)
    entries.push({ name, file, size: info.size })
  }
  return entries
}

async function releaseDetails(gh, tag) {
  const raw = await gh(['release', 'view', tag, '--json', 'assets,isDraft,isPrerelease'])
  const detail = JSON.parse(raw)
  if (!Array.isArray(detail.assets)) throw new Error('GitHub returned invalid release asset data')
  return detail
}

/**
 * Publish as a draft and upload one asset at a time. A 5xx after GitHub
 * accepts an upload is recoverable: inspect the remote asset before retrying.
 */
export async function publishRelease(
  { tag, prerelease, directory },
  { gh = github, sleep = wait } = {}
) {
  const { version, prerelease: tagIsPrerelease } = parseReleaseTag(tag)
  if (prerelease !== tagIsPrerelease) throw new Error('Release channel does not match the tag')
  const assets = await localAssets(resolve(directory), version)

  let releaseExists = false
  try {
    await releaseDetails(gh, tag)
    releaseExists = true
  } catch {
    // A missing release is normal before first publication.
  }

  if (!releaseExists) {
    for (let attempt = 1; attempt <= RETRIES; attempt++) {
      try {
        await gh(['release', 'create', tag, '--verify-tag', '--draft',
          '--title', `Spindle ${tag}`, '--generate-notes'])
      } catch (error) {
        // GitHub may create a draft, then return HTTP 500.
        try { await releaseDetails(gh, tag); releaseExists = true; break }
        catch { /* No accessible release yet. */ }
        if (!transient(error) || attempt === RETRIES) throw error
        console.warn(`Creating release failed transiently (attempt ${attempt}/${RETRIES})`)
        await sleep(2 ** attempt * 1000)
        continue
      }
      releaseExists = true
      break
    }
    if (!releaseExists) throw new Error('Could not create the draft release')
  }

  for (const asset of assets) {
    for (let attempt = 1; attempt <= RETRIES; attempt++) {
      const remote = await retry('Reading release assets',
        () => releaseDetails(gh, tag), sleep)
      const existing = remote.assets.find((item) => item.name === asset.name)
      if (existing && existing.size === asset.size) {
        console.log(`Already uploaded: ${asset.name}`)
        break
      }
      try {
        await gh(['release', 'upload', tag, asset.file, '--clobber'])
      } catch (error) {
        // A retry first checks whether the 5xx happened after upload succeeded.
        if (!transient(error) || attempt === RETRIES) throw error
        console.warn(`Uploading ${asset.name} failed transiently (attempt ${attempt}/${RETRIES})`)
        await sleep(2 ** attempt * 1000)
        continue
      }
      break
    }
  }

  // Verify every asset by name and size before making any new release public.
  const verify = async () => {
    const result = await releaseDetails(gh, tag)
    for (const asset of assets) {
      const remote = result.assets.find((item) => item.name === asset.name)
      if (!remote || remote.size !== asset.size) {
        throw new Error(`Published release asset missing or mismatched: ${asset.name}`)
      }
    }
  }
  await retry('Verifying uploaded release assets', verify, sleep)

  const editArgs = ['release', 'edit', tag, '--draft=false',
    `--prerelease=${prerelease}`]
  if (prerelease) editArgs.push('--latest=false')
  await retry('Publishing release', () => gh(editArgs), sleep)
  const final = await retry('Checking published release', () => releaseDetails(gh, tag), sleep)
  if (final.isDraft !== false || final.isPrerelease !== prerelease) {
    throw new Error('Release publication state is inconsistent')
  }
  console.log(`Published ${tag} with ${assets.length} verified assets`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [tag, channel, directory] = process.argv.slice(2)
  if (!tag || !['true', 'false'].includes(channel) || !directory) {
    console.error('Usage: node scripts/publish-release.mjs TAG true|false DIR')
    process.exitCode = 2
  } else {
    publishRelease({ tag, prerelease: channel === 'true', directory })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        console.error('Release publishing failed:', message)
        process.exitCode = 1
      })
  }
}
