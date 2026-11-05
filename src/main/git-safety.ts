import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { GitProcessError, runGit } from './git-process'
import { countGitStatus } from './git-inspection'
import type { GitSafetyCode, PullReadiness } from '../shared/git-safety'

/** No raw Git stderr, credential text, URLs or paths are exposed to Activity. */
export class GitSafetyError extends Error {
  constructor(readonly code: GitSafetyCode, message: string) {
    super(message)
    this.name = 'GitSafetyError'
  }
}

/** Only recognize specific transport failures; unknown Git errors remain generic. */
export function transportFailure(stderr: string): 'auth' | 'network' | null {
  if (/authentication failed|permission denied \(publickey\)|could not read username|could not read password|terminal prompts disabled|http[^\n]{0,25}\b(?:401|403)\b|invalid credentials|repository not found/i.test(stderr)) {
    return 'auth'
  }
  if (/could not resolve host|unable to access[^\n]*could not resolve|network is unreachable|connection timed out|connection refused|failed to connect|temporary failure in name resolution|connection reset by peer|the remote end hung up unexpectedly/i.test(stderr)) {
    return 'network'
  }
  return null
}

/** Standard Git runner; classified stderr stays in main-process memory only. */
export async function runRemoteGit(args: string[], signal: AbortSignal,
  onStderr?: (chunk: string) => void): Promise<string> {
  let diagnostic = ''
  try {
    return await runGit(args, signal, undefined, (chunk) => {
      diagnostic = (diagnostic + chunk).slice(-4096)
      onStderr?.(chunk)
    })
  } catch (error) {
    if (signal.aborted) throw error
    if (error instanceof GitProcessError && error.reason === 'failed') {
      const reason = transportFailure(diagnostic)
      if (reason) throw new GitSafetyError(reason,
        reason === 'auth' ? 'Git authentication failed; check the system Git credential helper.'
          : 'Git network connection failed; retry when online.')
    }
    throw error
  }
}

/** Explicitly prohibit incomplete merge/rebase/cherry-pick/revert states before pull. */
export async function assertNoGitOperation(root: string, signal: AbortSignal): Promise<void> {
  const gitDir = (await runGit(['-C', root, 'rev-parse', '--absolute-git-dir'], signal)).trim()
  if (!gitDir) throw new Error('Git metadata unavailable')
  const markers = ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD',
    'rebase-merge', 'rebase-apply', 'sequencer']
  if (markers.some((marker) => existsSync(join(gitDir, marker)))) {
    throw new GitSafetyError('operation-in-progress',
      'A merge, rebase, cherry-pick or revert is in progress.')
  }
}

export async function readGitChanges(root: string, signal: AbortSignal):
  Promise<Pick<PullReadiness, 'staged' | 'unstaged' | 'untracked' | 'conflicted'>> {
  const status = await runGit(['-c', 'core.fsmonitor=false', '-C', root,
    'status', '--porcelain=v1', '-z', '--untracked-files=normal'], signal)
  return countGitStatus(status)
}

export function assertCleanChanges(changes: Pick<PullReadiness,
  'staged' | 'unstaged' | 'untracked' | 'conflicted'>): void {
  if (changes.conflicted > 0) {
    throw new GitSafetyError('conflicted', 'Resolve local Git conflicts before pulling.')
  }
  if (changes.staged + changes.unstaged + changes.untracked > 0) {
    throw new GitSafetyError('dirty-worktree',
      'Working tree must be clean before pulling; fetch is still safe.')
  }
}

export async function gitDivergence(root: string, signal: AbortSignal):
  Promise<{ ahead: number; behind: number }> {
  const raw = (await runGit(['-C', root, 'rev-list', '--left-right',
    '--count', 'HEAD...@{upstream}'], signal)).trim()
  const match = raw.match(/^(\d+)\s+(\d+)$/)
  if (!match) throw new Error('Unable to compare Git histories')
  const ahead = Number(match[1])
  const behind = Number(match[2])
  if (![ahead, behind].every((value) => Number.isSafeInteger(value) && value <= 1_000_000)) {
    throw new Error('Git history count is outside supported limits')
  }
  return { ahead, behind }
}

export function assertFastForward(divergence: { ahead: number; behind: number }): void {
  if (divergence.ahead > 0 && divergence.behind > 0) {
    throw new GitSafetyError('diverged', 'Local and upstream commits have diverged; pull cannot fast-forward.')
  }
}
