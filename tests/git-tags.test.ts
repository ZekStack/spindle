import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { listGitTags, mutateGitTag, TagLifecycleError } from '../src/main/git-tags'
import { validateTagMutation, validateTagName } from '../src/shared/tags'
import { LocalWorkspaceStore } from '../src/main/local-workspaces'
import { JobManager } from '../src/main/jobs'
import type { GitHubClient } from '../src/main/github'

function git(...args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', timeout: 20_000 }).trim()
}
async function eventually(done: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 180; attempt++) {
    if (done()) return
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('Tag job did not reach a terminal state')
}
const offline = {
  repository: async () => { throw new Error('Unexpected API call') },
  releases: async () => [],
  workflowRuns: async () => []
} as unknown as Pick<GitHubClient, 'repository' | 'releases' | 'workflowRuns'>

test('tag names and mutation fields reject unsafe or ambiguous ref inputs', () => {
  for (const accepted of ['v0.1.0', 'release/2026-11', 'rc_2', 'stable']) {
    assert.equal(validateTagName(accepted), accepted)
  }
  for (const rejected of [
    '--force', 'refs/tags/v1', 'v1..2', 'a//b', '.hidden', 'a/.hidden', 'a/b.',
    'tag.lock', 'x\\y', 'x\ny', 'a*', 'a?b', 'a@{1}', '', 'x'.repeat(101)
  ]) {
    assert.throws(() => validateTagName(rejected), /Invalid Git tag name/, rejected)
  }
  const oid = 'a'.repeat(40)
  assert.deepEqual(validateTagMutation({
    action: 'create', tag: 'v1', mode: 'annotated', message: 'message', expectedHead: oid
  }), { action: 'create', tag: 'v1', mode: 'annotated', message: 'message', expectedHead: oid })
  for (const bad of [
    { action: 'create', tag: 'v1', mode: 'annotated', expectedHead: oid },
    { action: 'create', tag: 'v1', mode: 'lightweight', expectedHead: oid, message: 'unsafe' },
    { action: 'push', tag: 'v1', expectedLocalOid: 'bad' },
    { action: 'delete-origin', tag: 'v1', expectedOriginOid: 'bad' },
    { action: 'delete-both', tag: 'v1', expectedLocalOid: oid },
    { action: 'push', tag: 'v1', expectedLocalOid: oid, message: 'no' },
    { action: 'reset', tag: 'v1' }
  ]) assert.throws(() => validateTagMutation(bad))
})

test('tags are safely created, published, inspected and deleted independently', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'spindle-tags-'))
  const initial = {
    count: process.env.GIT_CONFIG_COUNT,
    key: process.env.GIT_CONFIG_KEY_0,
    value: process.env.GIT_CONFIG_VALUE_0
  }
  try {
    const remote = join(folder, 'remote.git')
    const seed = join(folder, 'seed')
    const checkout = join(folder, 'checkout')
    git('init', '--bare', '-q', remote)
    git('init', '-q', '-b', 'main', seed)
    git('-C', seed, 'config', 'user.name', 'Spindle Tests')
    git('-C', seed, 'config', 'user.email', 'spindle@example.org')
    writeFileSync(join(seed, 'README.md'), 'first\n')
    git('-C', seed, 'add', '.')
    git('-C', seed, 'commit', '-qm', 'initial')
    git('-C', seed, 'remote', 'add', 'origin', remote)
    git('-C', seed, 'push', '-q', '-u', 'origin', 'main')
    git('-C', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main')
    git('clone', '-q', remote, checkout)
    git('-C', checkout, 'config', 'user.name', 'Spindle Tests')
    git('-C', checkout, 'config', 'user.email', 'spindle@example.org')
    git('-C', checkout, 'remote', 'set-url', 'origin',
      'https://github.com/ExampleOrg/project.git')
    process.env.GIT_CONFIG_COUNT = '1'
    process.env.GIT_CONFIG_KEY_0 = `url.${pathToFileURL(remote).href}.insteadOf`
    process.env.GIT_CONFIG_VALUE_0 = 'https://github.com/ExampleOrg/project.git'
    const store = new LocalWorkspaceStore(join(folder, 'workspaces.json'))
    await store.linkFromPicker('ExampleOrg/project', checkout)
    const signal = new AbortController().signal
    const events: string[] = []
    const report = (message: string) => events.push(message)
    const initialState = await listGitTags(store, 'ExampleOrg/project', signal)
    assert.equal(initialState.originState, 'available')
    assert.equal(initialState.total, 0)
    assert.ok(initialState.head)
    const head = initialState.head!

    await assert.rejects(mutateGitTag(store, 'ExampleOrg/project', {
      action: 'create', tag: 'future', mode: 'lightweight', expectedHead: 'b'.repeat(40)
    }, signal, report, () => {}), (error: unknown) =>
      error instanceof TagLifecycleError && error.code === 'tag-stale')
    await mutateGitTag(store, 'ExampleOrg/project', {
      action: 'create', tag: 'v1.0.0', mode: 'annotated',
      message: 'A private release announcement', expectedHead: head
    }, signal, report, () => {})
    await mutateGitTag(store, 'ExampleOrg/project', {
      action: 'create', tag: 'v2.0.0', mode: 'lightweight', expectedHead: head
    }, signal, report, () => {})
    const first = await listGitTags(store, 'ExampleOrg/project', signal)
    assert.equal(first.localTotal, 2)
    assert.equal(first.originTotal, 0)
    assert.equal(first.total, 2)
    assert.deepEqual(first.entries.map(entry => [entry.name, entry.local?.kind]),
      [['v1.0.0', 'annotated'], ['v2.0.0', 'lightweight']])
    const v1 = first.entries[0].local!.oid
    const v2 = first.entries[1].local!.oid
    assert.notEqual(v1, head, 'An annotated tag is a tag object, not its commit')

    await mutateGitTag(store, 'ExampleOrg/project', {
      action: 'push', tag: 'v1.0.0', expectedLocalOid: v1
    }, signal, report, () => {})
    let current = await listGitTags(store, 'ExampleOrg/project', signal)
    assert.equal(current.entries[0].origin?.oid, v1)
    assert.equal(current.entries[1].origin, null)
    assert.ok(events.some(message => message.includes('Origin accepted')))
    await assert.rejects(mutateGitTag(store, 'ExampleOrg/project', {
      action: 'push', tag: 'v1.0.0', expectedLocalOid: v1
    }, signal, report, () => {}), (error: unknown) =>
      error instanceof TagLifecycleError && error.code === 'tag-exists')

    // A wrong expected remote SHA never removes or moves a published tag.
    await assert.rejects(mutateGitTag(store, 'ExampleOrg/project', {
      action: 'delete-origin', tag: 'v1.0.0', expectedOriginOid: head
    }, signal, report, () => {}), (error: unknown) =>
      error instanceof TagLifecycleError && error.code === 'tag-stale')
    assert.equal((await listGitTags(store, 'ExampleOrg/project', signal)).entries[0].origin?.oid, v1)

    // Detect an explicitly configured different push destination before mutation.
    git('-C', checkout, 'config', 'remote.origin.pushurl', 'https://github.com/Other/repo.git')
    await assert.rejects(mutateGitTag(store, 'ExampleOrg/project', {
      action: 'delete-origin', tag: 'v1.0.0', expectedOriginOid: v1
    }, signal, report, () => {}), /destination|origin/i)
    git('-C', checkout, 'config', '--unset', 'remote.origin.pushurl')

    await mutateGitTag(store, 'ExampleOrg/project', {
      action: 'delete-local', tag: 'v1.0.0', expectedLocalOid: v1
    }, signal, report, () => {})
    current = await listGitTags(store, 'ExampleOrg/project', signal)
    assert.equal(current.entries[0].local, null)
    assert.equal(current.entries[0].origin?.oid, v1)

    // Origin deletion leaves local v2 and the checkout's HEAD unchanged.
    let remoteDeleted = false
    await mutateGitTag(store, 'ExampleOrg/project', {
      action: 'delete-origin', tag: 'v1.0.0', expectedOriginOid: v1
    }, signal, report, () => { remoteDeleted = true })
    assert.equal(remoteDeleted, true)
    current = await listGitTags(store, 'ExampleOrg/project', signal)
    assert.equal(current.originTotal, 0)
    assert.equal(current.localTotal, 1)
    assert.equal(current.entries[0].name, 'v2.0.0')
    assert.equal(git('-C', checkout, 'rev-parse', 'HEAD'), head)

    await mutateGitTag(store, 'ExampleOrg/project', {
      action: 'push', tag: 'v2.0.0', expectedLocalOid: v2
    }, signal, report, () => {})
    current = await listGitTags(store, 'ExampleOrg/project', signal)
    assert.equal(current.originTotal, 1)

    // The combined action deletes origin first, then the same local OID.
    let calls = 0
    await mutateGitTag(store, 'ExampleOrg/project', {
      action: 'delete-both', tag: 'v2.0.0',
      expectedLocalOid: v2, expectedOriginOid: v2
    }, signal, report, () => { calls++ })
    assert.equal(calls, 1)
    assert.equal((await listGitTags(store, 'ExampleOrg/project', signal)).total, 0)
    assert.equal(git('-C', checkout, 'rev-parse', 'HEAD'), head)

    // Activity history does not persist the annotation message.
    const manager = new JobManager(join(folder, 'jobs.json'), offline, store)
    const record = manager.mutateTag('ExampleOrg', 'project', {
      action: 'create', tag: 'v3.0.0', mode: 'annotated',
      expectedHead: head, message: 'SECRET_ONLY_FOR_GIT'
    })
    assert.equal(record.kind, 'local-git-tag')
    assert.equal(JSON.stringify(manager.list()).includes('SECRET_ONLY_FOR_GIT'), false)
    assert.equal(readFileSync(join(folder, 'jobs.json'), 'utf8').includes('SECRET_ONLY_FOR_GIT'), false)
    await eventually(() => manager.list()[0]?.phase === 'completed')
    assert.equal(new JobManager(join(folder, 'jobs.json'), offline, store).list()[0].phase,
      'completed')
    assert.equal(manager.list()[0].tagOperation?.action, 'create')
    assert.equal(readFileSync(join(folder, 'jobs.json'), 'utf8').includes('SECRET_ONLY_FOR_GIT'), false)

    // Remote-first combined deletion reports partial success if local ref changes mid-job.
    const snapshot = await listGitTags(store, 'ExampleOrg/project', signal)
    const v3 = snapshot.entries[0].local!.oid
    await mutateGitTag(store, 'ExampleOrg/project', {
      action: 'push', tag: 'v3.0.0', expectedLocalOid: v3
    }, signal, report, () => {})
    let replaced = false
    const watch = manager.subscribe(jobs => {
      const active = jobs[0]
      if (active?.kind === 'local-git-tag' && active.tagRemoteDeleted && !replaced) {
        replaced = true
        git('-C', checkout, 'update-ref', 'refs/tags/v3.0.0', head)
      }
    })
    manager.mutateTag('ExampleOrg', 'project', {
      action: 'delete-both', tag: 'v3.0.0',
      expectedLocalOid: v3, expectedOriginOid: v3
    })
    await eventually(() => manager.list()[0]?.phase === 'partial')
    watch()
    assert.equal(replaced, true)
    assert.equal(manager.list()[0].tagRemoteDeleted, true)
    assert.equal(manager.list()[0].errorCode, 'tag-partial')
    const partial = await listGitTags(store, 'ExampleOrg/project', signal)
    assert.equal(partial.originTotal, 0)
    assert.equal(partial.localTotal, 1)
    assert.equal(partial.entries[0].local?.oid, head)
    assert.equal(readFileSync(join(folder, 'jobs.json'), 'utf8').includes('SECRET_ONLY_FOR_GIT'), false)
  } finally {
    for (const [key, value] of [
      ['GIT_CONFIG_COUNT', initial.count], ['GIT_CONFIG_KEY_0', initial.key],
      ['GIT_CONFIG_VALUE_0', initial.value]
    ] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(folder, { recursive: true, force: true })
  }
})

test('queued tag jobs cancel without storing annotation text or starting Git', () => {
  const folder = mkdtempSync(join(tmpdir(), 'spindle-tags-queue-'))
  try {
    const local = new LocalWorkspaceStore(join(folder, 'settings.json'))
    const manager = new JobManager(join(folder, 'jobs.json'), offline, local)
    assert.throws(() => manager.mutateTag('ExampleOrg', 'project', {
      action: 'create', tag: 'v1', mode: 'annotated',
      expectedHead: 'a'.repeat(40), message: 'SECRET_TAG_TEXT'
    }), /linked/)
    assert.deepEqual(manager.list(), [])
  } finally { rmSync(folder, { recursive: true, force: true }) }
})
