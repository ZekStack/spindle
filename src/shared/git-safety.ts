/** Fixed, non-sensitive reasons used across IPC, UI and Activity history. */
export type GitSafetyCode =
  | 'checkout-moved' | 'origin-mismatch' | 'detached-head' | 'upstream-missing'
  | 'upstream-mismatch' | 'operation-in-progress' | 'conflicted'
  | 'dirty-worktree' | 'diverged' | 'auth' | 'network'

export interface PullReadiness {
  ready: boolean
  reason: GitSafetyCode | null
  branch: string | null
  staged: number
  unstaged: number
  untracked: number
  conflicted: number
  ahead: number | null
  behind: number | null
}

export const GIT_SAFETY_CODES: readonly GitSafetyCode[] = [
  'checkout-moved', 'origin-mismatch', 'detached-head', 'upstream-missing',
  'upstream-mismatch', 'operation-in-progress', 'conflicted', 'dirty-worktree',
  'diverged', 'auth', 'network'
]

export function validPullReadiness(raw: unknown): raw is PullReadiness {
  if (!raw || typeof raw !== 'object') return false
  const value = raw as Record<string, unknown>
  const count = (input: unknown) => Number.isSafeInteger(input) &&
    (input as number) >= 0 && (input as number) <= 1_000_000
  return typeof value.ready === 'boolean' &&
    (value.reason === null || GIT_SAFETY_CODES.includes(value.reason as GitSafetyCode)) &&
    (value.ready === (value.reason === null)) &&
    (value.branch === null || typeof value.branch === 'string' &&
      value.branch.length <= 150 && /^[a-zA-Z0-9._/-]+$/.test(value.branch)) &&
    count(value.staged) && count(value.unstaged) && count(value.untracked) &&
    count(value.conflicted) && (value.ahead === null || count(value.ahead)) &&
    (value.behind === null || count(value.behind))
}
