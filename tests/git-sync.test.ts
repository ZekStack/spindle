import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { LocalWorkspaceStore } from '../src/main/local-workspaces'
import { cloneCheckout, syncCheckout, validateSyncCheckout } from '../src/main/git-sync'
import { JobManager } from '../src/main/jobs'
import type { GitHubClient } from '../src/main/github'

function git(...args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', timeout: 20_000 }).trim()
}

function fileText(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
}

async function eventually(ready: () => boolean): Promise<void> {
  for (let i = 0; i < 150; i++) {
    if (ready()) return
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('Git job did not reach terminal state')
}

test('clone and sync use saved roots, validated GitHub origins, and ff-only pull', async () => {
  const root = mkdtempSync(join(tmpdir(), 'spindle-sync-'))
  const oldEnv = {
    count: process.env.GIT_CONFIG_COUNT,
    key: process.env.GIT_CONFIG_KEY_0,
    value: process.env.GIT_CONFIG_VALUE_0
  }
  try {
    const bare = join(root, 'remote.git')
    const seed = join(root, 'seed')
    git('init', '--bare', '-q', bare)
    git('init', '-q', '-b', 'main', seed)
    git('-C', seed, 'config', 'user.email', 'tests@example.org')
    git('-C', seed, 'config', 'user.name', 'Spindle Tests')
    writeFileSync(join(seed, 'README.md'), 'first\n')
    git('-C', seed, 'add', 'README.md')
    git('-C', seed, 'commit', '-q', '-m', 'First commit')
    git('-C', seed, 'remote', 'add', 'origin', bare)
    git('-C', seed, 'push', '-q', '-u', 'origin', 'main')
    git('-C', bare, 'symbolic-ref', 'HEAD', 'refs/heads/main')

    // Intercept only this test's synthetic HTTPS origin using Git's documented
    // config environment. Production never receives a renderer-supplied URL.
    process.env.GIT_CONFIG_COUNT = '1'
    process.env.GIT_CONFIG_KEY_0 = `url.${pathToFileURL(bare).href}.insteadOf`
    process.env.GIT_CONFIG_VALUE_0 = 'https://github.com/ExampleOrg/project.git'

    const store = new LocalWorkspaceStore(join(root, 'locations.json'))
    store.addRootFromPicker(root)
    // The native picker store canonicalizes Windows 8.3 and long-path aliases.
    const savedRoot = store.load().roots[0]
    const target = store.cloneDestination('ExampleOrg/project', savedRoot)
    const events: string[] = []
    await cloneCheckout(store, 'ExampleOrg/project', target, new AbortController().signal,
      (message) => events.push(message))
    assert.equal(store.pathFor('exampleorg/PROJECT'), target)
    assert.match(git('-C', target, 'config', '--get', 'remote.origin.url'), /^https:\/\/github.com\//)
    assert.equal(git('-C', target, 'branch', '--show-current'), 'main')
    assert.ok(events.some((line) => line.includes('Verified checkout')))

    writeFileSync(join(seed, 'README.md'), 'second\n')
    git('-C', seed, 'add', 'README.md')
    git('-C', seed, 'commit', '-q', '-m', 'Second commit')
    git('-C', seed, 'push', '-q', 'origin', 'main')
    await syncCheckout(store, 'ExampleOrg/project', 'fetch', new AbortController().signal, () => {})
    assert.equal(fileText(join(target, 'README.md')), 'first\n')
    await syncCheckout(store, 'ExampleOrg/project', 'pull', new AbortController().signal, () => {})
    assert.equal(fileText(join(target, 'README.md')), 'second\n')

    writeFileSync(join(target, 'README.md'), 'local changes\n')
    await assert.rejects(syncCheckout(store, 'ExampleOrg/project', 'pull',
      new AbortController().signal, () => {}), /clean/)
    assert.equal(fileText(join(target, 'README.md')), 'local changes\n')
    git('-C', target, 'checkout', '--', 'README.md')
    git('-C', target, 'checkout', '--detach', '-q', 'HEAD')
    await assert.rejects(validateSyncCheckout(store, 'ExampleOrg/project',
      new AbortController().signal), /failed|branch|HEAD/i)

    // A destination cannot overwrite a pre-existing checkout or directory.
    const other = new LocalWorkspaceStore(join(root, 'other.json'))
    other.addRootFromPicker(root)
    await assert.rejects(cloneCheckout(other, 'ExampleOrg/project', target,
      new AbortController().signal, () => {}), /already exists/)
    assert.equal(fileText(join(target, 'README.md')), 'second\n')
    assert.throws(() => store.cloneDestination('ExampleOrg/project', join(root, 'unknown')))
  } finally {
    for (const [name, value] of [
      ['GIT_CONFIG_COUNT', oldEnv.count], ['GIT_CONFIG_KEY_0', oldEnv.key],
      ['GIT_CONFIG_VALUE_0', oldEnv.value]
    ] as const) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    rmSync(root, { recursive: true, force: true })
  }
})

test('Activity rejects unsafe clone roots and sync actions before launching Git', () => {
  const root = mkdtempSync(join(tmpdir(), 'spindle-sync-jobs-'))
  try {
    const local = new LocalWorkspaceStore(join(root, 'locations.json'))
    const github = {
      repository: async () => { throw new Error('Not used') },
      releases: async () => [],
      workflowRuns: async () => []
    } as unknown as Pick<GitHubClient, 'repository' | 'releases' | 'workflowRuns'>
    const manager = new JobManager(join(root, 'history.json'), github, local)
    assert.throws(() => manager.clone('ExampleOrg', 'project', root), /saved/)
    assert.throws(() => manager.sync('ExampleOrg', 'project', 'reset' as 'pull'), /Invalid/)
    assert.throws(() => manager.sync('ExampleOrg', 'project', 'pull'), /no linked/)
    assert.deepEqual(manager.list(), [])
    mkdirSync(join(root, 'workspace'))
    local.addRootFromPicker(join(root, 'workspace'))
    const queued = manager.clone('ExampleOrg', 'project', local.load().roots[0])
    assert.equal(queued.kind, 'local-git-clone')
    assert.equal(queued.action, 'clone')
    assert.throws(() => manager.clone('ExampleOrg', 'project', local.load().roots[0]),
      /already running/)
    manager.cancel(queued.id)
    assert.equal(manager.list()[0].phase, 'cancelled')
    assert.equal(manager.list()[0].retryable, false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
