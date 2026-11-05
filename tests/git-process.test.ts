import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JobManager } from '../src/main/jobs'
import { runGit } from '../src/main/git-process'
import type { GitHubClient } from '../src/main/github'

const offline = {
  repository: async () => { throw new Error('Unexpected GitHub request') },
  releases: async () => { throw new Error('Unexpected GitHub request') },
  workflowRuns: async () => { throw new Error('Unexpected GitHub request') }
} as unknown as Pick<GitHubClient, 'repository' | 'releases' | 'workflowRuns'>

async function eventually(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('Local Git job did not settle')
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore', timeout: 10_000 })
}

test('local Git inspection uses a real child process and persists only safe summaries', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spindle-git-'))
  const checkout = join(dir, 'checkout')
  const history = join(dir, 'activity.json')
  try {
    mkdirSync(checkout)
    git(checkout, 'init', '-q')
    git(checkout, 'config', 'user.name', 'Test')
    git(checkout, 'config', 'user.email', 'test@example.invalid')
    writeFileSync(join(checkout, 'tracked.txt'), 'initial\n')
    git(checkout, 'add', 'tracked.txt')
    git(checkout, 'commit', '-qm', 'initial')
    writeFileSync(join(checkout, 'tracked.txt'), 'modified\n')
    writeFileSync(join(checkout, 'staged.txt'), 'staged\n')
    git(checkout, 'add', 'staged.txt')
    writeFileSync(join(checkout, 'private-name.txt'), 'untracked\n')
    git(checkout, 'remote', 'add', 'origin', 'https://name:TOPSECRET@github.com/org/repo.git')

    const manager = new JobManager(history, offline)
    const started = manager.inspectLocal(checkout)
    assert.equal(started.kind, 'local-git-inspection')
    assert.equal(manager.inspectLocal(checkout).id, started.id, 'duplicate runs should coalesce')
    await eventually(() => manager.list()[0]?.phase === 'completed')
    const finished = manager.list()[0]
    assert.equal(finished.progress, 100)
    assert.equal(finished.errorCode, null)
    assert.ok(finished.output.some((line) => line.includes('Staged: 1; modified: 1; untracked: 1.')))
    const output = JSON.stringify(finished.output)
    assert.equal(output.includes('TOPSECRET'), false)
    assert.equal(output.includes('private-name.txt'), false)
    assert.equal(output.includes('github.com'), false)
    assert.equal(new JobManager(history, offline).list()[0].location, finished.location)

    const retry = manager.retryLocal(started.id)
    assert.notEqual(retry.id, started.id)
    await eventually(() => manager.list()[0]?.phase === 'completed')
    assert.throws(() => manager.retryLocal('not-an-id'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('non-repository folders fail safely without persisting raw Git messages', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spindle-git-'))
  try {
    const manager = new JobManager(join(dir, 'jobs.json'), offline)
    const job = manager.inspectLocal(dir)
    await eventually(() => manager.list()[0]?.phase === 'failed')
    assert.equal(manager.list()[0].errorCode, 'unknown')
    assert.equal(manager.list()[0].output.join(' ').includes('fatal:'), false)
    assert.equal(manager.list()[0].output.join(' ').includes(dir), false)
    assert.throws(() => manager.retryLocal('invalid-id'))
    const queued = manager.inspectLocal(dir)
    manager.cancel(queued.id)
    assert.equal(manager.list()[0].phase, 'cancelled')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Git process runner honors pre-cancelled requests', async () => {
  const cancelled = new AbortController()
  cancelled.abort()
  await assert.rejects(runGit(['--version'], cancelled.signal), { name: 'AbortError' })
  const version = await runGit(['--version'], new AbortController().signal)
  assert.match(version, /^git version /)
})
