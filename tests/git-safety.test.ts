import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { LocalWorkspaceStore } from '../src/main/local-workspaces'
import { pullReadiness, syncCheckout, validateSyncCheckout } from '../src/main/git-sync'
import { transportFailure, GitSafetyError } from '../src/main/git-safety'
import { validPullReadiness } from '../src/shared/git-safety'
import { JobManager } from '../src/main/jobs'
import type { GitHubClient } from '../src/main/github'

const repo = 'ExampleOrg/project'
const clean = new AbortController().signal
function git(...args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', timeout: 20_000 }).trim()
}
async function eventually(done: () => boolean) {
  for (let n = 0; n < 150; n++) {
    if (done()) return
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('Git operation did not finish')
}
const offline = {
  repository: async () => { throw new Error('Unused') },
  releases: async () => [],
  workflowRuns: async () => []
} as unknown as Pick<GitHubClient, 'repository' | 'releases' | 'workflowRuns'>

test('pull checks local changes and protects files; dirty/detached checkouts can still fetch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'spindle-safety-'))
  const original = {
    count: process.env.GIT_CONFIG_COUNT,
    key: process.env.GIT_CONFIG_KEY_0,
    value: process.env.GIT_CONFIG_VALUE_0
  }
  try {
    const remote = join(root, 'remote.git')
    const seed = join(root, 'seed')
    const checkout = join(root, 'checkout')
    git('init', '--bare', '-q', remote)
    git('init', '-q', '-b', 'main', seed)
    git('-C', seed, 'config', 'user.name', 'Spindle Test')
    git('-C', seed, 'config', 'user.email', 'test@example.invalid')
    writeFileSync(join(seed, 'README.md'), 'original\n')
    git('-C', seed, 'add', '.')
    git('-C', seed, 'commit', '-qm', 'initial')
    git('-C', seed, 'remote', 'add', 'origin', remote)
    git('-C', seed, 'push', '-q', '-u', 'origin', 'main')
    git('-C', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main')
    git('clone', '-q', remote, checkout)
    git('-C', checkout, 'config', 'user.name', 'Spindle Test')
    git('-C', checkout, 'config', 'user.email', 'test@example.invalid')
    git('-C', checkout, 'remote', 'set-url', 'origin', 'https://github.com/ExampleOrg/project.git')
    process.env.GIT_CONFIG_COUNT = '1'
    process.env.GIT_CONFIG_KEY_0 = `url.${pathToFileURL(remote).href}.insteadOf`
    process.env.GIT_CONFIG_VALUE_0 = 'https://github.com/ExampleOrg/project.git'
    const store = new LocalWorkspaceStore(join(root, 'locations.json'))
    await store.linkFromPicker(repo, checkout)

    const initial = await pullReadiness(store, repo, clean)
    assert.equal(initial.ready, true)
    assert.equal(initial.branch, 'main')
    assert.deepEqual([initial.ahead, initial.behind], [0, 0])
    assert.equal(validPullReadiness(initial), true)

    const secret = join(checkout, 'private-untracked-file.txt')
    writeFileSync(secret, 'keep this file\n')
    const dirty = await pullReadiness(store, repo, clean)
    assert.equal(dirty.reason, 'dirty-worktree')
    assert.equal(dirty.untracked, 1)
    await assert.rejects(syncCheckout(store, repo, 'pull', clean, () => {}),
      (error: unknown) => error instanceof GitSafetyError && error.code === 'dirty-worktree')
    await syncCheckout(store, repo, 'fetch', clean, () => {})
    assert.equal(readFileSync(secret, 'utf8'), 'keep this file\n')
    assert.equal(readFileSync(join(checkout, 'README.md'), 'utf8').replace(/\r\n/g, '\n'), 'original\n')

    // A blocked Activity job has a safe, structured, persisted diagnostic.
    const manager = new JobManager(join(root, 'activity.json'), offline, store)
    manager.sync('ExampleOrg', 'project', 'pull')
    await eventually(() => manager.list()[0]?.phase === 'failed')
    assert.equal(manager.list()[0].errorCode, 'dirty-worktree')
    assert.equal(manager.list()[0].retryable, false)
    assert.equal(JSON.stringify(manager.list()).includes('private-untracked'), false)
    assert.equal(new JobManager(join(root, 'activity.json'), offline, store).list()[0].errorCode,
      'dirty-worktree')
    unlinkSync(secret)

    git('-C', checkout, 'checkout', '-q', '--detach', 'HEAD')
    const detached = await pullReadiness(store, repo, clean)
    assert.equal(detached.reason, 'detached-head')
    await syncCheckout(store, repo, 'fetch', clean, () => {})
    await assert.rejects(validateSyncCheckout(store, repo, clean),
      (error: unknown) => error instanceof GitSafetyError && error.code === 'detached-head')
    git('-C', checkout, 'checkout', '-q', 'main')

    git('-C', checkout, 'branch', '--unset-upstream')
    assert.equal((await pullReadiness(store, repo, clean)).reason, 'upstream-missing')
    await syncCheckout(store, repo, 'fetch', clean, () => {})
    git('-C', checkout, 'branch', '--set-upstream-to=origin/main', 'main')

    const head = git('-C', checkout, 'rev-parse', 'HEAD')
    writeFileSync(join(checkout, '.git', 'MERGE_HEAD'), head + '\n')
    assert.equal((await pullReadiness(store, repo, clean)).reason, 'operation-in-progress')
    unlinkSync(join(checkout, '.git', 'MERGE_HEAD'))
    assert.equal((await pullReadiness(store, repo, clean)).ready, true)

    // No explicit stash, reset, clean or worktree-overwrite action is exposed.
    writeFileSync(join(seed, 'README.md'), 'remote fast-forward\n')
    git('-C', seed, 'add', '.')
    git('-C', seed, 'commit', '-qm', 'remote update')
    git('-C', seed, 'push', '-q', 'origin', 'main')
    await syncCheckout(store, repo, 'pull', clean, () => {})
    assert.equal(readFileSync(join(checkout, 'README.md'), 'utf8').replace(/\r\n/g, '\n'),
      'remote fast-forward\n')

    // A local commit and a different fetched remote commit cannot fast-forward.
    git('-C', checkout, 'commit', '-q', '--allow-empty', '-m', 'local commit')
    git('-C', seed, 'commit', '-q', '--allow-empty', '-m', 'other remote commit')
    git('-C', seed, 'push', '-q', 'origin', 'main')
    await syncCheckout(store, repo, 'fetch', clean, () => {})
    const divergent = await pullReadiness(store, repo, clean)
    assert.equal(divergent.reason, 'diverged')
    assert.equal(divergent.ahead, 1)
    assert.equal(divergent.behind, 1)
    const before = git('-C', checkout, 'rev-parse', 'HEAD')
    await assert.rejects(syncCheckout(store, repo, 'pull', clean, () => {}),
      (error: unknown) => error instanceof GitSafetyError && error.code === 'diverged')
    assert.equal(git('-C', checkout, 'rev-parse', 'HEAD'), before)

    // Real conflict remains user-owned; no automatic merge resolution.
    writeFileSync(join(checkout, 'README.md'), 'local conflicting edit\n')
    git('-C', checkout, 'add', '.')
    git('-C', checkout, 'commit', '-qm', 'local edit')
    writeFileSync(join(seed, 'README.md'), 'remote conflicting edit\n')
    git('-C', seed, 'add', '.')
    git('-C', seed, 'commit', '-qm', 'remote edit')
    git('-C', seed, 'push', '-q', 'origin', 'main')
    await syncCheckout(store, repo, 'fetch', clean, () => {})
    assert.throws(() => git('-C', checkout, 'merge', 'origin/main'))
    const conflict = await pullReadiness(store, repo, clean)
    assert.equal(conflict.reason, 'conflicted')
    assert.equal(conflict.conflicted, 1)
    await assert.rejects(syncCheckout(store, repo, 'pull', clean, () => {}),
      (error: unknown) => error instanceof GitSafetyError && error.code === 'conflicted')
    assert.ok(readFileSync(join(checkout, 'README.md'), 'utf8').includes('<<<<<<<'))
    assert.equal(validPullReadiness(conflict), true)
  } finally {
    for (const [key, value] of [
      ['GIT_CONFIG_COUNT', original.count],
      ['GIT_CONFIG_KEY_0', original.key],
      ['GIT_CONFIG_VALUE_0', original.value]
    ] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(root, { recursive: true, force: true })
  }
})

test('Git safety diagnostics are bounded and never copy stderr credentials', () => {
  assert.equal(transportFailure('fatal: Authentication failed for https://user:SECRET@github.com/a/b'),
    'auth')
  assert.equal(transportFailure('fatal: Could not resolve host: github.com'), 'network')
  assert.equal(transportFailure('fatal: could not read Username for https://github.com: terminal prompts disabled'),
    'auth')
  assert.equal(transportFailure('fatal: unrelated error /home/user/private-path'), null)
  assert.equal(validPullReadiness({
    ready: false, reason: 'not-a-code', branch: null,
    staged: 0, unstaged: 0, untracked: 0, conflicted: 0, ahead: null, behind: null
  }), false)
})
