import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'

export function expectedFiles(platform, version) {
  const suffix = platform === 'linux'
    ? ['Spindle-' + version + '-linux-x64.AppImage', 'Spindle-' + version + '-linux-x64.deb']
    : platform === 'windows'
      ? ['Spindle-Setup-' + version + '-windows-x64.exe']
      : platform === 'all'
        ? [
            'Spindle-' + version + '-linux-x64.AppImage',
            'Spindle-' + version + '-linux-x64.deb',
            'Spindle-Setup-' + version + '-windows-x64.exe'
          ]
        : null
  if (!suffix) throw new Error('Unknown platform: ' + platform)
  return suffix
}

function main() {
  const [platform, version, directory] = process.argv.slice(2)
  if (!/^\d+\.\d+\.\d+(?:-rc\.\d+)?$/.test(version || '')) throw new Error('Invalid version')
  const expected = expectedFiles(platform === '--missing-checksums' ? 'all' : platform, version)
  const actual = readdirSync(resolve(directory || 'release'))
  const missing = expected.filter((name) => !actual.includes(name))
  if (missing.length) throw new Error('Missing release assets: ' + missing.join(', '))
  const distributables = actual.filter((name) => /\.(?:deb|AppImage|exe)$/.test(name))
  const extra = distributables.filter((name) => !expected.includes(name))
  if (extra.length) throw new Error('Unexpected release assets: ' + extra.join(', '))
  console.log('Release assets verified: ' + expected.join(', '))
}
if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  try { main() } catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 }
}
