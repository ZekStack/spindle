import { runGit, GitProcessError } from './git-process'
import { runRemoteGit, GitSafetyError } from './git-safety'
import { validateSyncCheckout } from './git-sync'
import type { LocalWorkspaceStore } from './local-workspaces'
import {
  MAX_TAG_ENTRIES, TAG_OID_PATTERN, validateTagMutation, validateTagName,
  type GitTagsSnapshot, type GitTagEntry, type GitTagRef, type TagMutationRequest
} from '../shared/tags'

export type TagFailureCode = 'tag-stale' | 'tag-exists' | 'tag-missing' | 'tag-partial'

export class TagLifecycleError extends Error {
  constructor(readonly code: TagFailureCode, message: string) {
    super(message)
    this.name = 'TagLifecycleError'
  }
}
type Progress = (line: string, percent: number) => void
const refName = (tag: string) => `refs/tags/${validateTagName(tag)}`

function parseLocal(raw: string): Map<string, GitTagRef> {
  const map = new Map<string, GitTagRef>()
  for (const line of raw.trimEnd().split('\n')) {
    if (!line) continue
    const fields = line.split('\t')
    if (fields.length !== 3 || !TAG_OID_PATTERN.test(fields[1]) ||
      !['tag', 'commit', 'tree', 'blob'].includes(fields[2])) {
      throw new Error('Invalid local Git tag inventory')
    }
    try {
      const name = validateTagName(fields[0])
      map.set(name, { oid: fields[1], kind: fields[2] === 'tag' ? 'annotated' : 'lightweight' })
    } catch { /* Older exotic Git names cannot be operated on by this UI. */ }
  }
  return map
}

function parseRemote(raw: string): Map<string, GitTagRef> {
  const map = new Map<string, GitTagRef>()
  for (const line of raw.trimEnd().split('\n')) {
    if (!line) continue
    const fields = line.split('\t')
    if (fields.length !== 2 || !TAG_OID_PATTERN.test(fields[0]) ||
      !fields[1].startsWith('refs/tags/')) throw new Error('Invalid origin tag inventory')
    try {
      const name = validateTagName(fields[1].slice('refs/tags/'.length))
      map.set(name, { oid: fields[0] })
    } catch { /* Unsupported names remain untouched. */ }
  }
  return map
}

async function localTagOid(path: string, tag: string, signal: AbortSignal): Promise<string | null> {
  try {
    const oid = (await runGit(['-C', path, 'show-ref', '--verify', '--hash', refName(tag)], signal)).trim()
    if (!TAG_OID_PATTERN.test(oid)) throw new Error('Invalid local tag object')
    return oid
  } catch (error) {
    if (signal.aborted || !(error instanceof GitProcessError) || error.reason !== 'failed') throw error
    return null
  }
}

async function remoteTagOid(path: string, tag: string, signal: AbortSignal): Promise<string | null> {
  const raw = await runRemoteGit(['-C', path, 'ls-remote', '--tags', '--refs',
    'origin', refName(tag)], signal)
  return parseRemote(raw).get(tag)?.oid ?? null
}

async function currentHead(path: string, signal: AbortSignal): Promise<string | null> {
  try {
    const oid = (await runGit(['-C', path, 'rev-parse', '--verify', 'HEAD^{commit}'], signal)).trim()
    if (!TAG_OID_PATTERN.test(oid)) throw new Error('Invalid HEAD object')
    return oid
  } catch (error) {
    if (signal.aborted || !(error instanceof GitProcessError) || error.reason !== 'failed') throw error
    return null
  }
}

/** Live tag inventory. Remote failure is visible, never represented as zero remote tags. */
export async function listGitTags(
  store: LocalWorkspaceStore, repository: string, signal: AbortSignal
): Promise<GitTagsSnapshot> {
  const { path } = await validateSyncCheckout(store, repository, signal, 'fetch')
  const [head, localRaw, branch] = await Promise.all([
    currentHead(path, signal),
    runGit(['-C', path, 'for-each-ref',
      '--format=%(refname:strip=2)\t%(objectname)\t%(objecttype)', 'refs/tags'], signal),
    runGit(['-C', path, 'branch', '--show-current'], signal)
  ])
  const local = parseLocal(localRaw)
  let origin = new Map<string, GitTagRef>()
  let originState: GitTagsSnapshot['originState'] = 'available'
  let originError: GitTagsSnapshot['originError'] = null
  try {
    origin = parseRemote(await runRemoteGit(['-C', path, 'ls-remote', '--tags', '--refs', 'origin'], signal))
  } catch (error) {
    if (signal.aborted || error instanceof DOMException && error.name === 'AbortError') throw error
    originState = 'unavailable'
    originError = error instanceof GitSafetyError ? error.code : 'unknown'
  }
  const names = [...new Set([...local.keys(), ...origin.keys()])].sort()
  const entries: GitTagEntry[] = names.slice(0, MAX_TAG_ENTRIES).map(name => ({
    name, local: local.get(name) ?? null, origin: origin.get(name) ?? null
  }))
  return {
    head, branch: branch.trim() || null,
    localTotal: local.size, originTotal: origin.size, total: names.length,
    originState, originError, entries
  }
}

/**
 * Each request is an explicitly confirmed operation against a saved checkout.
 * Expected OIDs act as optimistic concurrency guards. Remote deletion uses
 * Git's force-with-lease compare-and-delete; never rewrite or force-push tags.
 */
export async function mutateGitTag(
  store: LocalWorkspaceStore, repository: string, supplied: TagMutationRequest,
  signal: AbortSignal, progress: Progress, onRemoteDelete: () => void
): Promise<void> {
  const request = validateTagMutation(supplied)
  const { path } = await validateSyncCheckout(store, repository, signal, 'fetch')
  const ref = refName(request.tag)
  progress('Verified linked checkout and GitHub origin.', 20)

  if (request.action === 'create') {
    if (await currentHead(path, signal) !== request.expectedHead) {
      throw new TagLifecycleError('tag-stale', 'HEAD moved since tag confirmation.')
    }
    if (await localTagOid(path, request.tag, signal)) {
      throw new TagLifecycleError('tag-exists', 'Local tag already exists.')
    }
    const args = ['-C', path, 'tag',
      ...(request.mode === 'annotated' ? ['-a', '-m', request.message!] : []),
      '--', request.tag, request.expectedHead!]
    await runGit(args, signal)
    progress('Created local tag at the confirmed commit.', 100)
    return
  }

  if (request.expectedLocalOid) {
    const current = await localTagOid(path, request.tag, signal)
    if (!current) throw new TagLifecycleError('tag-missing', 'Local tag is missing.')
    if (current !== request.expectedLocalOid) {
      throw new TagLifecycleError('tag-stale', 'Local tag changed since confirmation.')
    }
  }

  if (request.action === 'push') {
    const remote = await remoteTagOid(path, request.tag, signal)
    if (remote) throw new TagLifecycleError('tag-exists', 'Origin tag already exists. No overwrite performed.')
    progress('Publishing tag to origin without force.', 55)
    await runRemoteGit(['-C', path, 'push', '--porcelain',
      `--force-with-lease=${ref}:`, 'origin', `${ref}:${ref}`], signal)
    progress('Origin accepted tag publication.', 100)
    return
  }

  if (request.expectedOriginOid) {
    const current = await remoteTagOid(path, request.tag, signal)
    if (!current) throw new TagLifecycleError('tag-missing', 'Origin tag is already missing.')
    if (current !== request.expectedOriginOid) {
      throw new TagLifecycleError('tag-stale', 'Origin tag moved since confirmation.')
    }
  }

  if (request.action === 'delete-origin' || request.action === 'delete-both') {
    progress('Deleting only the confirmed origin tag with a lease.', 55)
    await runRemoteGit(['-C', path, 'push', '--porcelain',
      `--force-with-lease=${ref}:${request.expectedOriginOid}`,
      'origin', `:${ref}`], signal)
    onRemoteDelete()
    progress('Origin tag deleted; GitHub Releases are unaffected.', 75)
  }

  if (request.action === 'delete-local' || request.action === 'delete-both') {
    if (signal.aborted) return
    // Expected old OID makes local deletion atomic; never delete a moved ref.
    await runGit(['-C', path, 'update-ref', '-d', ref, request.expectedLocalOid!], signal)
    progress('Confirmed local tag deleted.', 100)
  } else {
    progress('Confirmed origin tag deleted.', 100)
  }
}
