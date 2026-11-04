import {
  isPrereleaseVersion, parseReleaseVersion,
  type UpdateErrorCode, type UpdatePhase, type UpdateStatus
} from './update-policy'

export type UpdateOperation = 'check' | 'download' | 'install'
export type UpdateInstallType = 'deb' | 'appimage' | 'nsis' | 'unknown'

/** Called before transitioning to error so the last failed phase survives. */
export function failedUpdateOperation(phase: UpdatePhase): UpdateOperation {
  if (phase === 'installing') return 'install'
  if (phase === 'downloading' || phase === 'ready') return 'download'
  return 'check'
}

const phases: readonly string[] = [
  'disabled', 'idle', 'checking', 'up-to-date', 'available',
  'downloading', 'ready', 'installing', 'error'
]
const errorCodes: readonly string[] = [
  'auth', 'network', 'verification', 'generic',
  'install-failed', 'not-installed', 'wrong-launcher'
]
const operations: readonly string[] = ['check', 'download', 'install']
const installTypes: readonly string[] = ['deb', 'appimage', 'nsis', 'unknown']

function allowed(value: unknown, values: readonly string[]): string {
  return typeof value === 'string' && values.includes(value) ? value : 'unknown'
}

function version(value: unknown): string {
  return typeof value === 'string' && parseReleaseVersion(value) ? value : 'unknown'
}

function safeTime(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return 'never'
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : 'never'
}

/**
 * Only stable, allowlisted data crosses into a support report. Never serialize
 * Electron/updater errors, paths, headers, environment variables or feed URLs.
 */
export function formatUpdateDiagnostics(
  status: UpdateStatus,
  platform: string,
  lastCheckCompletedAt: number | null
): string {
  const current = version(status.currentVersion)
  const available = status.availableVersion === null ? 'none' : version(status.availableVersion)
  const safePlatform = allowed(platform, ['linux', 'win32', 'darwin'])
  return [
    'Spindle update diagnostics',
    `Platform: ${safePlatform}`,
    `Installer: ${allowed(status.installType, installTypes)}`,
    `Channel: ${isPrereleaseVersion(current) ? 'rc' : 'stable'}`,
    `Running version: ${current}`,
    `Available version: ${available}`,
    `Phase: ${allowed(status.phase, phases)}`,
    `Failed operation: ${status.failureStage === null ? 'none' : allowed(status.failureStage, operations)}`,
    `Error category: ${status.message === null ? 'none' : allowed(status.message satisfies UpdateErrorCode, errorCodes)}`,
    `Last completed check: ${safeTime(lastCheckCompletedAt)}`
  ].join('\n')
}
