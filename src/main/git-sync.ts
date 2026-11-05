import { lstatSync, realpathSync } from 'node:fs'
import { dirname } from 'node:path'
import { parseRepositoryFullName } from '../shared/contracts'
import { githubOriginRepository, type LocalWorkspaceStore } from './local-workspaces'
import { runGit } from './git-process'

export type SyncOperation = 'fetch' | 'pull'
export type GitProgress = (message: string, percent: number) => void

function progress(onProgress: GitProgress, start: number, extent: number) {
  let tail = ''
  let highest = -1
  return (chunk: string) => {
    // Git emits progress on stderr with carriage returns and arbitrary paths.
    // Only a small allowlist of operation names and percentages may reach Activity.
    tail = (tail + chunk).slice(-256)
    const matches = [...tail.matchAll(/(Counting objects|Compressing objects|Receiving objects|Resolving deltas|Writing objects):\s*(\d{1,3})%/g)]
    const match = matches.at(-1)
    if (!match) return
    const value = Number(match[2])
    if (value > 100) return
    const mapped = start + Math.round(extent * value / 100)
    if (mapped <= highest || (mapped < highest + 3 && value !== 100)) return
    highest = mapped
    onProgress(`Git transfer: ${match[1]} ${value}%.`, mapped)
  }
}

function unavailableDestination(destination: string): boolean {
  try {
    lstatSync(destination)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw new Error('Cannot inspect clone destination')
  }
}

/** Clone to a verified saved root. Failed clones are never silently removed. */
export async function cloneCheckout(
  store: LocalWorkspaceStore, repository: string, destination: string,
  signal: AbortSignal, onProgress: GitProgress
): Promise<void> {
  const { owner, name } = parseRepositoryFullName(repository)
  const allowed = store.cloneDestination(repository, dirname(destination))
  if (allowed !== destination) throw new Error('Clone destination changed')
  if (unavailableDestination(destination)) throw new Error('Clone destination already exists')
  onProgress('Cloning repository with local Git credentials.', 15)
  await runGit([
    'clone', '--progress', '--origin', 'origin', '--',
    `https://github.com/${owner}/${name}.git`, destination
  ], signal, undefined, progress(onProgress, 20, 65))
  if (signal.aborted) return
  onProgress('Validating cloned GitHub origin.', 90)
  // Uses the same strict origin verifier as an explicitly linked checkout.
  await store.linkFromPicker(repository, destination)
  onProgress('Verified checkout linked to repository.', 100)
}

/** Reject a replaced checkout, another origin, detached HEAD or invalid upstream. */
export async function validateSyncCheckout(
  store: LocalWorkspaceStore, repository: string, signal: AbortSignal
): Promise<{ path: string; branch: string }> {
  const path = store.pathFor(repository)
  let live: string
  try { live = realpathSync.native(path) }
  catch { throw new Error('Linked checkout is missing; relink it first') }
  if (live !== path) throw new Error('Linked checkout moved; relink it first')
  const top = (await runGit(['-c', 'core.fsmonitor=false', '-C', path,
    'rev-parse', '--show-toplevel'], signal)).trim()
  if (realpathSync.native(top) !== live) throw new Error('Linked checkout root changed')
  const origin = (await runGit(['-C', path, 'remote', 'get-url', 'origin'], signal)).trim()
  if (githubOriginRepository(origin)?.toLowerCase() !== repository.toLowerCase()) {
    throw new Error('GitHub origin does not match linked repository')
  }
  const branch = (await runGit(['-C', path, 'symbolic-ref', '--quiet', '--short', 'HEAD'], signal)).trim()
  if (!branch || branch.length > 150 || /[\x00-\x1f\x7f]/.test(branch)) {
    throw new Error('Checkout has no supported current branch')
  }
  const upstream = (await runGit(['-C', path, 'rev-parse',
    '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], signal)).trim()
  if (upstream !== `origin/${branch}`) throw new Error('Branch must track its matching origin branch')
  return { path, branch }
}

export async function syncCheckout(
  store: LocalWorkspaceStore, repository: string, operation: SyncOperation,
  signal: AbortSignal, onProgress: GitProgress
): Promise<void> {
  if (operation !== 'fetch' && operation !== 'pull') throw new Error('Invalid Git operation')
  onProgress('Verifying checkout origin, branch and upstream.', 15)
  const { path, branch } = await validateSyncCheckout(store, repository, signal)
  if (signal.aborted) return
  onProgress('Verified origin and tracked branch.', 30)
  if (operation === 'pull') {
    const dirty = await runGit(['-c', 'core.fsmonitor=false', '-C', path,
      'status', '--porcelain=v1', '--untracked-files=normal'], signal)
    if (dirty) throw new Error('Working tree must be clean before pulling')
    if (signal.aborted) return
    onProgress('Working tree clean; fast-forward-only pull.', 40)
    await runGit(['-C', path, 'pull', '--ff-only', '--progress', 'origin', branch],
      signal, undefined, progress(onProgress, 45, 45))
  } else {
    await runGit(['-C', path, 'fetch', '--progress', 'origin'],
      signal, undefined, progress(onProgress, 35, 55))
  }
  if (signal.aborted) return
  onProgress(operation === 'pull' ? 'Fast-forward pull completed.' : 'Fetch completed.', 100)
}
