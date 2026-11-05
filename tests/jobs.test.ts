import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JobManager } from '../src/main/jobs'
import { validateJobId } from '../src/shared/jobs'
import type { GitHubClient } from '../src/main/github'
import type { Repository } from '../src/shared/contracts'

const repository: Repository = {
  id: 1, fullName: 'ExampleOrg/project', name: 'project',
  description: null, private: false, archived: false,
  defaultBranch: 'main', updatedAt: '2026-11-05T00:00:00Z',
  htmlUrl: 'https://github.com/ExampleOrg/project'
}

const inspector = {
  repository: async () => repository,
  releases: async () => [],
  workflowRuns: async () => []
} satisfies Pick<GitHubClient, 'repository' | 'releases' | 'workflowRuns'>

async function settle(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 60; i++) {
    if (predicate()) return
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Job did not reach expected state')
}

test('real repository inspection runs outside the Activity dialog and persists safe history', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spindle-activity-'))
  const file = join(dir, 'history.json')
  try {
    const manager = new JobManager(file, inspector)
    const updates: number[] = []
    const unsubscribe = manager.subscribe((jobs) => updates.push(jobs[0]?.progress ?? 0))
    const started = manager.inspect('ExampleOrg', 'project')
    assert.equal(started.phase, 'queued')
    assert.equal(started.repository, 'ExampleOrg/project')
    await settle(() => manager.list()[0]?.phase === 'completed')
    unsubscribe()
    const final = manager.list()[0]
    assert.equal(final.progress, 100)
    assert.equal(final.errorCode, null)
    assert.equal(final.startedAt !== null, true)
    assert.equal(final.finishedAt !== null, true)
    assert.ok(updates.includes(33))
    assert.ok(final.output.some((line) => line.includes('workflow runs')))
    assert.deepEqual(new JobManager(file, inspector).list(), [final])
  } finally { rmSync(dir, { force: true, recursive: true }) }
})

test('cancelling a running job aborts its API request and remains cancelled', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spindle-activity-'))
  const file = join(dir, 'history.json')
  let aborted = false
  try {
    const stalled = {
      ...inspector,
      repository: async (_owner: string, _name: string, signal?: AbortSignal): Promise<Repository> =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            aborted = true
            reject(new Error('Request aborted'))
          }, { once: true })
        })
    }
    const manager = new JobManager(file, stalled)
    const initial = manager.inspect('ExampleOrg', 'project')
    await settle(() => manager.list()[0]?.phase === 'running')
    const cancelled = manager.cancel(initial.id)
    assert.equal(cancelled.phase, 'cancelled')
    await settle(() => aborted)
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(manager.list()[0].phase, 'cancelled')
    assert.equal(manager.list()[0].errorCode, null)
    assert.equal(manager.list()[0].finishedAt !== null, true)
  } finally { rmSync(dir, { force: true, recursive: true }) }
})

test('new manager marks unfinished jobs interrupted and rejects unsafe IDs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spindle-activity-'))
  const file = join(dir, 'history.json')
  try {
    const stalled = { ...inspector, repository: async (): Promise<Repository> =>
      new Promise(() => {}) }
    const first = new JobManager(file, stalled)
    const active = first.inspect('ExampleOrg', 'project')
    await settle(() => first.list()[0]?.phase === 'running')
    const restored = new JobManager(file, inspector)
    const job = restored.list()[0]
    assert.equal(job.id, active.id)
    assert.equal(job.phase, 'interrupted')
    assert.equal(job.errorCode, 'interrupted')
    assert.equal(job.finishedAt !== null, true)
    assert.throws(() => validateJobId('../../secret'))
    assert.throws(() => restored.cancel('invalid job'))
    first.cancel(active.id)
  } finally { rmSync(dir, { force: true, recursive: true }) }
})
