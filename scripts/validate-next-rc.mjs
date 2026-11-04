import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseReleaseTag } from './prepare-release.mjs'

const RC = /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))-rc\.(0|[1-9]\d*)$/

/**
 * Require a fresh RC for the source version and never reuse, downgrade or
 * publish an RC after the corresponding stable tag already exists.
 *
 * Existing tags must be fetched from origin, not inferred from GitHub Releases:
 * a tag can exist even if publication has failed.
 */
export function validateNextReleaseCandidate(tag, existingTags, sourceVersion) {
  const { version, prerelease } = parseReleaseTag(tag)
  const match = RC.exec(tag)
  if (!prerelease || !match) throw new Error('Expected an RC tag such as v0.1.0-rc.9')
  const [, base, suffix] = match
  const requested = Number(suffix)
  if (!Number.isSafeInteger(requested)) throw new Error('RC number is out of range')
  if (base !== sourceVersion) {
    throw new Error(`Requested base ${base} does not match package.json ${sourceVersion}`)
  }

  if (existingTags.includes(tag)) throw new Error(`Tag ${tag} already exists; never move it`)
  if (existingTags.includes(`v${base}`)) {
    throw new Error('A stable release already exists for this base version')
  }

  const rcPrefix = `v${base}-rc.`
  const numbers = existingTags
    .filter((existing) => existing.startsWith(rcPrefix) && RC.test(existing))
    .map((existing) => Number(existing.slice(rcPrefix.length)))
    .filter(Number.isSafeInteger)
  const highest = numbers.length ? Math.max(...numbers) : -1
  if (requested <= highest) {
    throw new Error(`RC must advance beyond existing ${rcPrefix}${highest}`)
  }
  return version
}

function main() {
  const [tag, tagsFile] = process.argv.slice(2)
  if (!tag || !tagsFile) {
    throw new Error('Usage: node scripts/validate-next-rc.mjs TAG EXISTING_TAGS_FILE')
  }
  const root = fileURLToPath(new URL('../', import.meta.url))
  const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
  const tags = readFileSync(tagsFile, 'utf8').split(/\r?\n/).filter(Boolean)
  process.stdout.write(validateNextReleaseCandidate(tag, tags, packageJson.version) + '\n')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main() } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
