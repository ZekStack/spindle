import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function expectedFiles(platform, version) {
  const linux = [
    `Spindle-${version}-linux-x64.AppImage`,
    `Spindle-${version}-linux-x64.deb`
  ]
  const windows = [`Spindle-Setup-${version}-windows-x64.exe`]
  if (platform === 'linux') return linux
  if (platform === 'windows') return windows
  if (platform === 'all') return [...linux, ...windows]
  throw new Error('Unknown platform: ' + platform)
}

export function verifyArtifacts(platform, version, directory = 'release') {
  if (!/^\d+\.\d+\.\d+(?:-rc\.(?:0|[1-9]\d*))?$/.test(version || '')) {
    throw new Error('Invalid release version')
  }
  const expected = expectedFiles(platform, version)
  const actual = readdirSync(resolve(directory))
  const missing = expected.filter((name) => !actual.includes(name))
  if (missing.length) throw new Error('Missing release assets: ' + missing.join(', '))
  const distributables = actual.filter((name) => /\.(?:deb|AppImage|exe)$/.test(name))
  const unexpected = distributables.filter((name) => !expected.includes(name))
  if (unexpected.length) throw new Error('Unexpected release assets: ' + unexpected.join(', '))
  console.log('Verified release assets: ' + expected.join(', '))
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { verifyArtifacts(...process.argv.slice(2)) }
  catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 }
}
