import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Use the packaged builder marker, never infer the format from OS alone. */
export function detectLinuxPackage(resourcesPath: string, appImage = process.env.APPIMAGE):
  'deb' | 'appimage' | 'unknown' {
  if (appImage) return 'appimage'
  try {
    return readFileSync(join(resourcesPath, 'package-type'), 'utf8').trim() === 'deb'
      ? 'deb' : 'unknown'
  } catch {
    return 'unknown'
  }
}
