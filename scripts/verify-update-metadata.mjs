import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expectedFiles } from './verify-release-artifacts.mjs'

export function verifyUpdateMetadata(platform, version, directory = 'release') {
  const required = expectedFiles(platform, version)
  const location = resolve(directory)
  const names = readdirSync(location)
  const updates = names.filter((name) =>
    platform === 'windows' ? name === 'latest.yml' :
    platform === 'linux' ? /^latest-linux(?:-[\w-]+)?\.yml$/.test(name) :
    name === 'latest.yml' || /^latest-linux(?:-[\w-]+)?\.yml$/.test(name)
  )
  if (!updates.length) throw new Error('Missing GitHub auto-update manifests for ' + platform)
  const text = updates.map((name) => readFileSync(resolve(location, name), 'utf8')).join('\n')
  if (!text.includes('version: ' + version)) {
    throw new Error('Update manifests do not describe version ' + version)
  }
  if (!/sha512:\s*[\w+/=]{40,}/.test(text)) {
    throw new Error('Missing SHA-512 hashes in update manifests')
  }
  for (const name of required) {
    if (!text.includes(name)) throw new Error('Update manifest missing installer: ' + name)
  }
  console.log('Verified update feeds: ' + updates.join(', '))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { verifyUpdateMetadata(...process.argv.slice(2)) }
  catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 }
}
