import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { isNewerRelease, parseReleaseVersion } from '../shared/update-policy'

interface Attempt {
  from: string
  to: string
  startedAt: number
}

/** Records an install handoff so an unchanged version cannot silently re-offer forever. */
export function recordInstallAttempt(file: string, from: string, to: string, now = Date.now()): void {
  if (!parseReleaseVersion(from) || !isNewerRelease(from, to)) throw new Error('Invalid update attempt')
  writeFileSync(file, JSON.stringify({ from, to, startedAt: now } satisfies Attempt), { mode: 0o600 })
}

export function previousInstallUnapplied(file: string, version: string, now = Date.now()): boolean {
  if (!existsSync(file)) return false
  try {
    const attempt: Attempt = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof attempt.from !== 'string' || typeof attempt.to !== 'string' ||
        !Number.isFinite(attempt.startedAt) || !isNewerRelease(attempt.from, attempt.to)) {
      unlinkSync(file)
      return false
    }
    // Only block for a recent attempt made by the version we're still running.
    if (version !== attempt.from || now - attempt.startedAt > 7 * 24 * 60 * 60 * 1000 ||
        now < attempt.startedAt) {
      unlinkSync(file)
      return false
    }
    return true
  } catch {
    try { unlinkSync(file) } catch { /* Corrupt state is not fatal. */ }
    return false
  }
}

export function clearInstallAttempt(file: string): void {
  try { unlinkSync(file) } catch { /* Nothing to clear. */ }
}
