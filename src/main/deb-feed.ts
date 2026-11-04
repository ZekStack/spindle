import { DebInstallError } from './deb-install'

interface ManifestFile {
  url: string
  sha512?: string
}

/**
 * Choose one exact Spindle Debian asset before electron-updater resolves URLs
 * or creates its download task. Never fall back to AppImage or an unknown file.
 */
export function chooseDebAsset<T extends ManifestFile>(
  info: { version: string; files: readonly T[] }
): T {
  const expected = `Spindle-${info.version}-linux-x64.deb`
  const matches = info.files.filter((file) => {
    try {
      const path = decodeURIComponent(new URL(file.url, 'https://updates.invalid').pathname)
      return path.split('/').at(-1) === expected
    } catch {
      return false
    }
  })
  if (matches.length !== 1) {
    throw new DebInstallError('verification',
      `Expected exactly one Debian asset (${expected}); no update will be downloaded`)
  }
  const [file] = matches
  const digest = file.sha512
  if (typeof digest !== 'string' || !/^[A-Za-z0-9+/]{85,87}={0,2}$/.test(digest) ||
      Buffer.from(digest, 'base64').length !== 64) {
    throw new DebInstallError('verification',
      'Missing or invalid Debian asset SHA-512 in release metadata')
  }
  return file
}
