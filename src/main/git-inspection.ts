import { realpathSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { GitProcessError, runGit } from './git-process'
import { githubOriginRepository, type LocalWorkspaceStore } from './local-workspaces'
import { MAX_VISIBLE_TAGS, type GitTagInventory, type GitRemoteTags, type LocalGitInspection } from '../shared/git-inspection'

type Progress = (message: string, percent: number) => void
const REF_PATTERN = /^[a-zA-Z0-9._/-]{1,128}$/
const HASH_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/

function safeRef(value: string): string | null {
  if (!value) return null
  return REF_PATTERN.test(value) ? value : '(omitted)'
}

function checkedCount(value: string): number {
  const parsed = Number(value)
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed > 1_000_000) {
    throw new Error('Git count is outside the supported range')
  }
  return parsed
}

/** Porcelain -z is essential: paths may contain spaces, newlines and renames consume two NUL records. */
export function countGitStatus(raw: string): Pick<LocalGitInspection, 'staged' | 'unstaged' | 'untracked' | 'conflicted'> {
  const result = { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 }
  if (!raw) return result
  if (!raw.endsWith('\0')) throw new Error('Incomplete Git status')
  const entries = raw.slice(0, -1).split('\0')
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (entry.length < 4 || entry[2] !== ' ') throw new Error('Malformed Git status')
    const x = entry[0]
    const y = entry[1]
    if (x === '?' && y === '?') {
      result.untracked++
    } else if (x === '!' && y === '!') {
      continue
    } else {
      if (x !== ' ') result.staged++
      if (y !== ' ') result.unstaged++
      if (['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(x + y)) result.conflicted++
      // In -z format Git emits a separate old path after rename/copy records.
      if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
        if (++i >= entries.length) throw new Error('Incomplete Git rename status')
      }
    }
  }
  return result
}

/** A local -z ref inventory contains tag names only; remote refs use SHA + TAB + refs/tags/name. */
function tagInventory(raw: string, remote: boolean): GitTagInventory {
  const names: string[] = []
  let total = 0
  for (const line of raw.split('\n')) {
    if (!line) continue
    let name = line
    if (remote) {
      const match = line.match(/^(?:[a-f0-9]{40}|[a-f0-9]{64})\trefs\/tags\/(.+)$/)
      if (!match) throw new Error('Unexpected remote tag response')
      name = match[1]
    }
    total++
    if (total > 1_000_000) throw new Error('Too many Git tags')
    if (names.length < MAX_VISIBLE_TAGS && REF_PATTERN.test(name)) names.push(name)
  }
  return { names, total }
}

async function optionalGit(args: string[], signal: AbortSignal): Promise<string | null> {
  try { return await runGit(args, signal) }
  catch (error) {
    if (signal.aborted || !(error instanceof GitProcessError) || error.reason !== 'failed') throw error
    return null
  }
}

/**
 * Read-only, bounded snapshot. A picked folder never causes a network request.
 * Linked folders may query remote tags only AFTER origin ownership validation.
 */
export async function inspectGitCheckout(
  selected: string, signal: AbortSignal, progress: Progress,
  linkedRepository?: string, local?: LocalWorkspaceStore
): Promise<LocalGitInspection> {
  const top = (await runGit(['-c', 'core.fsmonitor=false', '-C', selected,
    'rev-parse', '--show-toplevel'], signal)).trim()
  if (!isAbsolute(top)) throw new Error('Not a Git worktree')
  const root = realpathSync.native(top)
  if (linkedRepository) {
    if (!local || root !== local.pathFor(linkedRepository)) {
      throw new Error('Linked checkout moved; relink it before inspection')
    }
    const origin = (await runGit(['-C', root, 'config', '--get', 'remote.origin.url'], signal)).trim()
    if (githubOriginRepository(origin)?.toLowerCase() !== linkedRepository.toLowerCase()) {
      throw new Error('Linked GitHub origin changed; relink it before inspection')
    }
  }
  progress('Git working tree verified.', 35)
  const branchRaw = (await runGit(['-C', root, 'branch', '--show-current'], signal)).trim()
  const branch = safeRef(branchRaw)
  const headRaw = (await optionalGit(['-C', root, 'rev-parse', '--verify', '--quiet', 'HEAD'], signal))?.trim() ?? ''
  const commit = HASH_PATTERN.test(headRaw) ? headRaw : null
  const upstreamRaw = branchRaw && commit
    ? (await optionalGit(['-C', root, 'rev-parse', '--abbrev-ref', '--symbolic-full-name',
      '@{upstream}'], signal))?.trim() ?? '' : ''
  const upstream = safeRef(upstreamRaw)
  let ahead: number | null = null
  let behind: number | null = null
  if (commit && upstreamRaw) {
    const counts = (await runGit(['-C', root, 'rev-list', '--left-right', '--count',
      'HEAD...@{upstream}'], signal)).trim().split(/\s+/)
    if (counts.length !== 2) throw new Error('Invalid Git upstream comparison')
    ahead = checkedCount(counts[0])
    behind = checkedCount(counts[1])
  }
  progress('Branch, commit and upstream inspected.', 55)
  const status = await runGit(['-c', 'core.fsmonitor=false', '-C', root,
    'status', '--porcelain=v1', '-z', '--untracked-files=normal'], signal)
  const changes = countGitStatus(status)
  progress('Staged, modified and untracked changes counted.', 75)
  const localOutput = await runGit(['-C', root, 'for-each-ref',
    '--format=%(refname:strip=2)', 'refs/tags'], signal)
  const localTags = tagInventory(localOutput, false)
  progress('Local tags enumerated.', 85)
  let remoteTags: GitRemoteTags = { state: 'not-requested', names: [], total: 0 }
  if (linkedRepository) {
    try {
      const remoteOutput = await runGit(['-C', root, 'ls-remote', '--tags', '--refs', 'origin'], signal)
      remoteTags = { state: 'available', ...tagInventory(remoteOutput, true) }
    } catch (error) {
      if (signal.aborted || error instanceof DOMException && error.name === 'AbortError') throw error
      // Lack of network or Git credentials is not an empty remote inventory.
      remoteTags = { state: 'unavailable', names: [], total: 0 }
    }
  }
  progress(remoteTags.state === 'unavailable'
    ? 'Remote tags unavailable; local snapshot retained.'
    : 'Git inspection collected.', 95)
  return {
    inspectedAt: new Date().toISOString(),
    branch, detached: !branchRaw, commit, upstream, ahead, behind,
    ...changes, localTags, remoteTags
  }
}
