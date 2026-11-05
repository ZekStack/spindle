import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { countGitStatus, inspectGitCheckout } from '../src/main/git-inspection'
import { LocalWorkspaceStore } from '../src/main/local-workspaces'
import { JobManager } from '../src/main/jobs'
import { validGitInspection } from '../src/shared/git-inspection'
import type { GitHubClient } from '../src/main/github'

function git(...args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', timeout: 20_000 }).trim()
}

async function eventually(done: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (done()) return
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('Inspection job did not settle')
}

const inspector = {
  repository: async () => { throw new Error('Unexpected GitHub call') },
  releases: async () => [],
  workflowRuns: async () => []
} as unknown as Pick<GitHubClient, 'repository' | 'releases' | 'workflowRuns'>

test('NUL-separated Git status counts renames without interpreting file names', () => {
  assert.deepEqual(countGitStatus('R  renamed.txt\0old name.txt\0 M changed.txt\0?? new.txt\0'),
    { staged: 1, unstaged: 1, untracked: 1, conflicted: 0 })
  assert.deepEqual(countGitStatus('UU conflict.txt\0'), {
    staged: 1, unstaged: 1, untracked: 0, conflicted: 1
  })
  assert.deepEqual(countGitStatus(''), { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 })
  assert.throws(() => countGitStatus('R  new.txt\0'))
  assert.throws(() => countGitStatus('?? missing NUL'))
})

test('read-only inspection reports upstream divergence, changes, and local/remote tag distinctions', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'spindle-inspection-'))
  const original = {
    count: process.env.GIT_CONFIG_COUNT,
    key: process.env.GIT_CONFIG_KEY_0,
    value: process.env.GIT_CONFIG_VALUE_0
  }
  try {
    const remote = join(folder, 'origin.git')
    const seed = join(folder, 'seed')
    const checkout = join(folder, 'checkout')
    git('init', '--bare', '-q', remote)
    mkdirSync(seed)
    git('init', '-q', '-b', 'main', seed)
    git('-C', seed, 'config', 'user.name', 'Spindle Test')
    git('-C', seed, 'config', 'user.email', 'test@example.invalid')
    writeFileSync(join(seed, 'renamed-before.txt'), 'first\n')
    git('-C', seed, 'add', '.')
    git('-C', seed, 'commit', '-qm', 'first')
    git('-C', seed, 'tag', 'v1.0.0')
    git('-C', seed, 'remote', 'add', 'origin', remote)
    git('-C', seed, 'push', '-q', '-u', 'origin', 'main', '--tags')
    git('-C', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main')
    git('clone', '-q', remote, checkout)
    git('-C', checkout, 'config', 'user.email', 'test@example.invalid')
    git('-C', checkout, 'config', 'user.name', 'Spindle Test')
    git('-C', checkout, 'remote', 'set-url', 'origin', 'https://github.com/ExampleOrg/project.git')
    process.env.GIT_CONFIG_COUNT = '1'
    process.env.GIT_CONFIG_KEY_0 = `url.${pathToFileURL(remote).href}.insteadOf`
    process.env.GIT_CONFIG_VALUE_0 = 'https://github.com/ExampleOrg/project.git'
    const store = new LocalWorkspaceStore(join(folder, 'workspaces.json'))
    await store.linkFromPicker('ExampleOrg/project', checkout)

    git('-C', checkout, 'tag', 'local-only')
    git('-C', checkout, 'commit', '-q', '--allow-empty', '-m', 'local only')
    git('-C', seed, 'commit', '-q', '--allow-empty', '-m', 'remote only')
    git('-C', seed, 'tag', 'remote-only')
    git('-C', seed, 'push', '-q', 'origin', 'main', '--tags')
    // Fetch branch refs without importing tags so the test has a remote-only tag.
    git('-C', checkout, 'fetch', '-q', '--no-tags', 'origin')
    git('-C', checkout, 'mv', 'renamed-before.txt', 'renamed-after.txt')
    writeFileSync(join(checkout, 'renamed-after.txt'), 'edited\n')
    writeFileSync(join(checkout, 'sensitive-path.txt'), 'untracked\n')
    const events: string[] = []
    const snapshot = await inspectGitCheckout(store.pathFor('ExampleOrg/project'),
      new AbortController().signal, (message) => events.push(message),
      'ExampleOrg/project', store)
    assert.equal(snapshot.branch, 'main')
    assert.equal(snapshot.detached, false)
    assert.match(snapshot.commit ?? '', /^[a-f0-9]{40}$/)
    assert.equal(snapshot.upstream, 'origin/main')
    assert.equal(snapshot.ahead, 1)
    assert.equal(snapshot.behind, 1)
    assert.equal(snapshot.staged, 1)
    assert.equal(snapshot.unstaged, 1)
    assert.equal(snapshot.untracked, 1)
    assert.equal(snapshot.conflicted, 0)
    assert.deepEqual(snapshot.localTags.names.sort(), ['local-only', 'v1.0.0'])
    assert.deepEqual(snapshot.remoteTags.names.sort(), ['remote-only', 'v1.0.0'])
    assert.equal(snapshot.remoteTags.state, 'available')
    assert.equal(validGitInspection(snapshot), true)
    assert.equal(JSON.stringify(snapshot).includes('sensitive-path'), false)
    assert.equal(JSON.stringify(snapshot).includes('https://'), false)
    assert.ok(events.some((x) => x.includes('Remote') || x.includes('inspection')))

    const manager = new JobManager(join(folder, 'jobs.json'), inspector, store)
    const started = manager.inspectLinked('ExampleOrg', 'project')
    assert.equal(started.linkedRepository, 'ExampleOrg/project')
    assert.equal(manager.inspectLinked('ExampleOrg', 'project').id, started.id)
    await eventually(() => manager.list()[0]?.phase === 'completed')
    const inspected = manager.list()[0]
    assert.equal(inspected.inspection?.behind, 1)
    assert.equal(inspected.inspection?.remoteTags.state, 'available')
    assert.equal(inspected.inspection?.staged, 1)
    assert.equal(JSON.stringify(inspected).includes('sensitive-path'), false)
    assert.equal(JSON.stringify(inspected).includes('github.com'), false)
    const saved = JSON.parse(readFileSync(join(folder, 'jobs.json'), 'utf8')) as unknown
    assert.equal(JSON.stringify(saved).includes('sensitive-path'), false)
    const restored = new JobManager(join(folder, 'jobs.json'), inspector, store)
    assert.equal(restored.list()[0].inspection?.behind, 1)
    const retry = manager.retryLocal(inspected.id)
    assert.equal(retry.linkedRepository, 'ExampleOrg/project')
    await eventually(() => manager.list()[0]?.phase === 'completed')
    // Changing the origin invalidates linked inspection before remote access.
    git('-C', checkout, 'remote', 'set-url', 'origin', 'https://github.com/Other/not-project.git')
    await assert.rejects(inspectGitCheckout(checkout, new AbortController().signal,
      () => {}, 'ExampleOrg/project', store), /origin changed/)
    git('-C', checkout, 'remote', 'set-url', 'origin', 'https://github.com/ExampleOrg/project.git')
    git('-C', checkout, 'checkout', '-q', '--detach', 'HEAD')
    const detached = await inspectGitCheckout(checkout, new AbortController().signal,
      () => {}, 'ExampleOrg/project', store)
    assert.equal(detached.detached, true)
    assert.equal(detached.branch, null)
    assert.equal(detached.ahead, null)
    assert.equal(detached.behind, null)
    assert.ok(detached.commit)
  } finally {
    for (const [key, value] of [
      ['GIT_CONFIG_COUNT', original.count],
      ['GIT_CONFIG_KEY_0', original.key],
      ['GIT_CONFIG_VALUE_0', original.value]
    ] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(folder, { recursive: true, force: true })
  }
})

test('unborn local worktrees and detached HEAD remain readable without upstream', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'spindle-unborn-'))
  try {
    git('init', '-q', '-b', 'main', folder)
    const empty = await inspectGitCheckout(folder, new AbortController().signal, () => {})
    assert.equal(empty.branch, 'main')
    assert.equal(empty.commit, null)
    assert.equal(empty.upstream, null)
    assert.equal(empty.ahead, null)
    assert.equal(empty.remoteTags.state, 'not-requested')
    assert.equal(empty.localTags.total, 0)
    assert.equal(validGitInspection(empty), true)
    assert.equal(validGitInspection({ ...empty, localTags: { names: ['SECRET!'], total: 1 } }), false)
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
})
