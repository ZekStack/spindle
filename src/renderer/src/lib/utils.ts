import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
export function cn(...args: ClassValue[]): string { return twMerge(clsx(args)) }
export function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}
export function readableDate(value?: string | null, language = 'en'): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isFinite(date.valueOf())
    ? date.toLocaleDateString(language === 'hu' ? 'hu-HU' : 'en-GB', { dateStyle: 'medium' })
    : '—'
}

/** Render GitHub API failures in the selected UI language without raw HTTP data. */
export function localizedGitHubError(value: unknown, t: (key: string) => string): string {
  const message = errorMessage(value)
  const mappings: [string, string][] = [
    ['Sign in to GitHub to discover', 'githubSignInRequired'],
    ['GitHub authentication expired', 'githubInvalidCredentials'],
    ['GitHub denied this account access', 'githubAccessForbidden'],
    ['GitHub resource not found', 'githubNotFound'],
    ['GitHub API rate limit reached', 'githubRateLimited'],
    ['GitHub connection failed', 'githubNetworkUnavailable'],
    ['GitHub service is temporarily unavailable', 'githubServiceUnavailable']
  ]
  const mapped = mappings.find(([marker]) => message.includes(marker))
  if (!mapped) return message
  const wait = mapped[1] === 'githubRateLimited' ? /Retry after (\d+) seconds/.exec(message) : null
  return t(mapped[1]) + (wait ? ` (${wait[1]}s)` : '')
}
