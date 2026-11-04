import { basename } from 'node:path'
import { DebInstallError } from './deb-install'

export interface DownloadedRelease {
  version: string
  downloadedFile?: string
  files?: { url: string; sha512?: string }[]
}

/**
 * Explicitly binds the downloaded DEB to its release checksum. When a mixed
 * Linux feed contains AppImage and .deb entries, the updater must have selected
 * the DEB itself; selecting an AppImage is not a recoverable install operation.
 */
export function selectDownloadedDeb(info: DownloadedRelease): {
  file: string
  version: string
  sha512: string
} {
  const file = info.downloadedFile
  if (typeof file !== 'string' || !file.toLowerCase().endsWith('.deb')) {
    throw new DebInstallError('verification',
      'Linux package update selected a non-DEB installer; refusing to install it')
  }
  const filename = basename(file)
  const matches = (info.files ?? []).filter((entry) => {
    if (typeof entry.url !== 'string') return false
    const path = entry.url.split(/[?#]/, 1)[0]
    return decodeURIComponent(path.split('/').at(-1) || '') === filename &&
      path.toLowerCase().endsWith('.deb')
  })
  if (matches.length !== 1) {
    throw new DebInstallError('verification',
      'Cannot uniquely match the downloaded DEB to the published release metadata')
  }
  const sha512 = matches[0].sha512
  if (!sha512 || !/^[a-zA-Z0-9+/]{85,87}={0,2}$/.test(sha512) ||
      Buffer.from(sha512, 'base64').length !== 64) {
    throw new DebInstallError('verification', 'Missing or invalid DEB SHA-512 metadata')
  }
  return { file, version: info.version, sha512 }
}
