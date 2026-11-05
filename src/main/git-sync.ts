import { lstatSync, realpathSync } from 'node:fs'
import { dirname } from 'node:path'
import { parseRepositoryFullName } from '../shared/contracts'
import type { PullReadiness } from '../shared/git-safety'
import { githubOriginRepository, type LocalWorkspaceStore } from './local-workspaces'
import { GitProcessError, runGit } from './git-process'
import {
  GitSafetyError, assertCleanChanges, assertFastForward, assertNoGitOperation,
  gitDivergence, readGitChanges, runRemoteGit
} from './git-safety'

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
  await runRemoteGit([
    'clone', '--progress', '--origin', 'origin', '--',
    `https://github.com/${owner}/${name}.git`, destination
  ], signal, progress(onProgress, 20, 65))
  if (signal.aborted) return
  onProgress('Validating cloned GitHub origin.', 90)
  // Failed and interrupted clones are intentionally left for manual recovery.
  await store.linkFromPicker(repository, destination)
  onProgress('Verified checkout linked to repository.', 100)
}

/**
 * Verify a linked checkout before Git work.
 * Fetch only needs a trusted origin: a detached HEAD, dirty tree or missing
 * upstream does not make a non-worktree-mutating fetch dangerous.
 */
export async function validateSyncCheckout(
  store: LocalWorkspaceStore, repository: string, signal: AbortSignal,
  operation: SyncOperation = 'pull'
): Promise<{ path: string; branch: string | null }> {
  const path = store.pathFor(repository)
  let live: string
  try { live = realpathSync.native(path) }
  catch { throw new GitSafetyError('checkout-moved', 'Linked checkout is missing; relink it first.') }
  if (live !== path) {
    throw new GitSafetyError('checkout-moved', 'Linked checkout moved; relink it first.')
  }
  const top = (await runGit(['-c', 'core.fsmonitor=false', '-C', path,
    'rev-parse', '--show-toplevel'], signal)).trim()
  try {
    if (realpathSync.native(top) !== live) throw new Error('Checkout root changed')
  } catch {
    throw new GitSafetyError('checkout-moved', 'Linked checkout root changed; relink it.')
  }
  // Check the saved origin, not Git's transport URL (which may be rewritten
  // through the user's legitimate url.insteadOf config).
  let origin: string
  try {
    origin = (await runGit(['-C', path, 'config', '--get', 'remote.origin.url'], signal)).trim()
  } catch (error) {
    if (signal.aborted || error instanceof GitProcessError && error.reason !== 'failed') throw error
    throw new GitSafetyError('origin-mismatch', 'The linked checkout has no valid origin.')
  }
  if (githubOriginRepository(origin)?.toLowerCase() !== repository.toLowerCase()) {
    throw new GitSafetyError('origin-mismatch', 'GitHub origin does not match the linked repository.')
  }
  if (operation === 'fetch') return { path, branch: null }

  let branch: string
  try {
    branch = (await runGit(['-C', path, 'symbolic-ref', '--quiet', '--short', 'HEAD'], signal)).trim()
  } catch (error) {
    if (signal.aborted || error instanceof GitProcessError && error.reason !== 'failed') throw error
    throw new GitSafetyError('detached-head', 'Checkout has no current branch (detached HEAD).')
  }
  if (!branch || branch.length > 150 || /[\x00-\x1f\x7f]/.test(branch)) {
    throw new GitSafetyError('detached-head', 'Checkout has no supported current branch (detached HEAD).')
  }
  let upstream: string
  try {
    upstream = (await runGit(['-C', path, 'rev-parse',
      '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], signal)).trim()
  } catch (error) {
    if (signal.aborted || error instanceof GitProcessError && error.reason !== 'failed') throw error
    throw new GitSafetyError('upstream-missing', 'Current branch has no configured upstream.')
  }
  if (upstream !== `origin/${branch}`) {
    throw new GitSafetyError('upstream-mismatch', 'Branch must track its matching origin branch.')
  }
  return { path, branch }
}

/** Readiness is advisory; the real job repeats every guard immediately before a pull. */
export async function pullReadiness(
  store: LocalWorkspaceStore, repository: string, signal: AbortSignal
): Promise<PullReadiness> {
  const result: PullReadiness = {
    ready: true, reason: null, branch: null,
    staged: 0, unstaged: 0, untracked: 0, conflicted: 0, ahead: null, behind: null
  }
  try {
    const { path, branch } = await validateSyncCheckout(store, repository, signal)
    result.branch = branch
    const changes = await readGitChanges(path, signal)
    Object.assign(result, changes)
    // Show unresolved conflicts before generic in-progress or dirty warnings.
    if (changes.conflicted) assertCleanChanges(changes)
    await assertNoGitOperation(path, signal)
    assertCleanChanges(changes)
    const divergence = await gitDivergence(path, signal)
    Object.assign(result, divergence)
    assertFastForward(divergence)
  } catch (error) {
    if (!(error instanceof GitSafetyError) || signal.aborted) throw error
    result.ready = false
    result.reason = error.code
  }
  return result
}

export async function syncCheckout(
  store: LocalWorkspaceStore, repository: string, operation: SyncOperation,
  signal: AbortSignal, onProgress: GitProgress
): Promise<void> {
  if (operation !== 'fetch' && operation !== 'pull') throw new Error('Invalid Git operation')
  onProgress('Verifying linked GitHub origin.', 15)
  const { path, branch } = await validateSyncCheckout(store, repository, signal, operation)
  if (signal.aborted) return
  onProgress('Verified linked checkout.', 30)
  if (operation === 'pull') {
    // The review dialog is not a security boundary. Recheck inside the queued
    // main-process job, and again after remote refs are updated by fetch.
    const readiness = await pullReadiness(store, repository, signal)
    if (!readiness.ready && readiness.reason) {
      throw new GitSafetyError(readiness.reason, 'Local checkout is not safe for fast-forward pull.')
    }
    onProgress('Clean checkout and upstream verified.', 40)
    await runRemoteGit(['-C', path, 'fetch', '--progress', 'origin'],
      signal, progress(onProgress, 45, 30))
    if (signal.aborted) return
    await validateSyncCheckout(store, repository, signal)
    const currentChanges = await readGitChanges(path, signal)
    if (currentChanges.conflicted) assertCleanChanges(currentChanges)
    await assertNoGitOperation(path, signal)
    assertCleanChanges(currentChanges)
    assertFastForward(await gitDivergence(path, signal))
    if (signal.aborted) return
    // merge --ff-only cannot rewrite divergent history or create a merge
    // commit. Unlike pull, this does not consult pull.rebase configuration.
    onProgress('Applying fast-forward-only update.', 85)
    await runGit(['-C', path, 'merge', '--ff-only', '@{upstream}'], signal)
  } else {
    // Fetch touches remote tracking refs only. Allow detached HEAD, local
    // changes and conflicts; never reset, clean, stash or overwrite files.
    await runRemoteGit(['-C', path, 'fetch', '--progress', 'origin'],
      signal, progress(onProgress, 35, 55))
  }
  if (signal.aborted) return
  onProgress(operation === 'pull'
    ? `Fast-forward pull completed on ${branch ?? 'current branch'}.`
    : 'Fetch completed without changing working files.', 100)
}
