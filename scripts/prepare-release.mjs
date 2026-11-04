import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-rc\.(0|[1-9]\d*))?$/

export function parseReleaseTag(tag) {
  if (typeof tag !== 'string' || !TAG.test(tag)) {
    throw new Error('Expected vMAJOR.MINOR.PATCH or vMAJOR.MINOR.PATCH-rc.N (for example v0.1.0-rc.1)')
  }
  return { version: tag.slice(1), prerelease: tag.includes('-rc.') }
}

function main() {
  const [mode, tag] = process.argv.slice(2)
  if (!['--validate', '--prepare'].includes(mode)) throw new Error('Usage: node scripts/prepare-release.mjs --validate|--prepare TAG')
  const { version } = parseReleaseTag(tag)
  if (mode === '--prepare') {
    const root = fileURLToPath(new URL('../', import.meta.url))
    const manifestFile = resolve(root, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
    if (manifest.name !== 'spindle') throw new Error('Unexpected package name')
    manifest.version = version
    writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n')
  }
  process.stdout.write(version + '\n')
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main() } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
