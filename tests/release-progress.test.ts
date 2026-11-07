import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GitHubClient } from '../src/main/github'
import { JobManager } from '../src/main/jobs'
import {
  classifyReleaseProgress, correlateReleaseRuns, releasePollDelay,
  RELEASE_POLL_MAX_CHECKS, RELEASE_POLL_MAX_MS,
  type ReleaseProgressTarget, type ReleaseRunEvidence
} from '../src/shared/release-progress'
import type { JobRecord } from '../src/shared/jobs'

const TAG_OID = 'a'.repeat(40)
const COMMIT = 'b'.repeat(40)
const STARTED = '2026-11-07T18:00:00.000Z'
const sample: ReleaseProgressTarget = {
  jobId: randomUUID(), kind: 'tag-push', releaseAction: null,
  tagName: 'v1.2.3', expectedTagOid: TAG_OID,
  workflowId: 7, dispatchRef: null, startedAt: STARTED, phase: 'completed'
}
function run(id: number, overrides: Partial<ReleaseRunEvidence> = {}): ReleaseRunEvidence {
  return {
    id, workflowId: 7, event: 'push', status: 'completed',
    conclusion: 'success', headSha: COMMIT, headBranch: 'v1.2.3',
    createdAt: '2026-11-07T18:00:25.000Z',
    htmlUrl: `https://github.com/example/repo/actions/runs/${id}`,
    ...overrides
  }
}

test('run correlation needs workflow identity, tag name, exact commit, event and attempt window', () => {
  const records = [
    run(1, { workflowId: 8 }),
    run(2, { headSha: 'c'.repeat(40) }),
    run(3, { event: 'workflow_dispatch' }),
    run(4, { headBranch: 'v1.2.4' }),
    run(5, { createdAt: '2026-11-07T17:00:00Z' }),
    run(6)
  ]
  const found = correlateReleaseRuns(sample, COMMIT, records, false)
  assert.equal(found.correlation, 'verified')
  assert.equal(found.matched?.id, 6)
  assert.equal(found.candidateCount, 1)
  const ambiguous = correlateReleaseRuns(sample, COMMIT, [...records, run(7)], false)
  assert.equal(ambiguous.correlation, 'ambiguous')
  assert.equal(ambiguous.matched, null)
  assert.equal(correlateReleaseRuns(sample, COMMIT, records.slice(0, 5), true).correlation, 'unavailable')
})

test('dispatch correlation is always a candidate, never a verified run', () => {
  const target: ReleaseProgressTarget = {
    ...sample, kind: 'dispatch', dispatchRef: 'main'
  }
  const candidate = correlateReleaseRuns(target, COMMIT, [
    run(22, { event: 'workflow_dispatch', headBranch: 'main', headSha: 'd'.repeat(40) })
  ], false)
  assert.equal(candidate.correlation, 'candidate')
  assert.equal(candidate.matched?.id, 22)
  assert.equal(correlateReleaseRuns(target, COMMIT, [
    run(22, { event: 'workflow_dispatch', headBranch: 'main' }),
    run(23, { event: 'workflow_dispatch', headBranch: 'main' })
  ], false).correlation, 'ambiguous')
  const result = classifyReleaseProgress(target, 'matched', 'absent', 'candidate',
    run(22, { event: 'workflow_dispatch', headBranch: 'main', conclusion: 'failure' }))
  assert.equal(result.outcome, 'uncertain')
  assert.equal(result.settled, false)
})

test('published Release, draft, tampered tag and proven failed run have distinct recovery', () => {
  assert.deepEqual(classifyReleaseProgress(sample, 'matched', 'published', 'none', null), {
    outcome: 'published', recovery: 'inspect-release', settled: true
  })
  assert.deepEqual(classifyReleaseProgress(sample, 'changed', 'published', 'none', null), {
    outcome: 'uncertain', recovery: 'verify-manually', settled: true
  })
  const draft = classifyReleaseProgress({
    ...sample, kind: 'api', releaseAction: 'create-draft'
  }, 'matched', 'draft', 'none', null)
  assert.equal(draft.outcome, 'draft')
  assert.equal(draft.settled, true)
  assert.equal(classifyReleaseProgress(sample, 'matched', 'absent', 'verified',
    run(31, { conclusion: 'failure' })).outcome, 'failed')
  assert.equal(classifyReleaseProgress(sample, 'matched', 'absent', 'none', null).outcome, 'tag-only')
  assert.equal(classifyReleaseProgress({ ...sample, phase: 'running' },
    'absent', 'absent', 'none', null).outcome, 'running')
})

test('poll interval and observation deadline remain finite', () => {
  assert.ok(RELEASE_POLL_MAX_CHECKS <= 40)
  assert.ok(RELEASE_POLL_MAX_MS <= 10 * 60_000)
  assert.ok(releasePollDelay(0) >= 1000)
  assert.ok(releasePollDelay(1000) <= 30_000)
  assert.ok(releasePollDelay(20) >= releasePollDelay(2))
})

type Reply = { status?: number; json?: unknown; link?: string }
function fixture(routes: Record<string, Reply>) {
  const calls: Array<{ path: string; method: string }> = []
  const client = new GitHubClient((async (input, options) => {
    const url = new URL(String(input))
    const path = url.pathname + url.search
    const method = options?.method ?? 'GET'
    calls.push({ path, method })
    const found = routes[path] ?? routes[url.pathname]
    if (!found) return new Response('{}', { status: 404 })
    return new Response(JSON.stringify(found.json ?? {}), {
      status: found.status ?? 200,
      headers: found.link ? { Link: found.link } : undefined
    })
  }) as typeof fetch, {
    get: async () => ({ method: 'environment' as const, token: 'secret-not-leaked' })
  })
  const root = '/repos/ExampleOrg/demo'
  routes[root] ??= { json: {
    id: 1, full_name: 'ExampleOrg/demo', name: 'demo',
    description: null, private: false, archived: false,
    default_branch: 'main', updated_at: STARTED, html_url: 'https://github.com/ExampleOrg/demo'
  } }
  return { client, calls, root }
}

test('snapshot verifies tag object/commit, Release and assets independently of a run', async () => {
  const routes: Record<string, Reply> = {}
  const { client, calls, root } = fixture(routes)
  routes[root + '/git/ref/tags/v1.2.3'] = {
    json: { object: { type: 'tag', sha: TAG_OID } }
  }
  routes[root + '/git/tags/' + TAG_OID] = {
    json: { object: { type: 'commit', sha: COMMIT } }
  }
  routes[root + '/releases/tags/v1.2.3'] = {
    json: {
      id: 71, tag_name: 'v1.2.3', draft: false, prerelease: false,
      html_url: 'https://github.com/ExampleOrg/demo/releases/tag/v1.2.3',
      assets: [{ name: 'binary.deb' }, { name: 'binary.exe' }]
    }
  }
  routes[root + '/actions/workflows/7/runs'] = {
    json: { workflow_runs: [{
      id: 99, workflow_id: 7, event: 'push', status: 'completed',
      conclusion: 'success', head_sha: COMMIT, head_branch: 'v1.2.3',
      created_at: '2026-11-07T18:00:25Z',
      html_url: 'https://github.com/ExampleOrg/demo/actions/runs/99'
    }] }
  }
  const snapshot = await client.releaseProgress('ExampleOrg', 'demo', sample)
  assert.equal(snapshot.tag.state, 'matched')
  assert.equal(snapshot.tag.commitSha, COMMIT)
  assert.equal(snapshot.release.state, 'published')
  assert.deepEqual(snapshot.release.assetNames, ['binary.deb', 'binary.exe'])
  assert.equal(snapshot.run.correlation, 'verified')
  assert.equal(snapshot.run.matched?.id, 99)
  assert.equal(snapshot.outcome, 'published')
  assert.equal(snapshot.settled, true)
  assert.equal(calls.every(call => call.method === 'GET'), true)
})

test('missing release with an existing tag is not mistaken for publication', async () => {
  const routes: Record<string, Reply> = {}
  const { client, root } = fixture(routes)
  routes[root + '/git/ref/tags/v1.2.3'] = {
    json: { object: { type: 'commit', sha: TAG_OID } }
  }
  routes[root + '/releases/tags/v1.2.3'] = { status: 404 }
  routes[root + '/releases'] = { json: [] }
  routes[root + '/actions/workflows/7/runs'] = { json: { workflow_runs: [] } }
  const snapshot = await client.releaseProgress('ExampleOrg', 'demo', sample)
  assert.equal(snapshot.release.state, 'absent')
  assert.equal(snapshot.outcome, 'tag-only')
  assert.equal(snapshot.settled, false)
  assert.equal(snapshot.run.correlation, 'none')
})

test('bounded draft search and workflow pagination preserve uncertain evidence', async () => {
  const routes: Record<string, Reply> = {}
  const { client, root } = fixture(routes)
  routes[root + '/git/ref/tags/v1.2.3'] = { json: { object: { type: 'commit', sha: TAG_OID } } }
  routes[root + '/releases/tags/v1.2.3'] = { status: 404 }
  routes[root + '/releases'] = { json: [],
    link: '<https://api.github.com/page2>; rel="next"' }
  routes[root + '/actions/workflows/7/runs'] = { json: { workflow_runs: [] },
    link: '<https://api.github.com/page2>; rel="next"' }
  const result = await client.releaseProgress('ExampleOrg', 'demo', sample)
  assert.equal(result.release.state, 'unavailable')
  assert.equal(result.run.truncated, true)
  assert.equal(result.run.correlation, 'unavailable')
  assert.equal(result.outcome, 'uncertain')
})

test('historical Activity derives attempt provenance after restart without secret inputs', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'spindle-progress-'))
  const path = join(folder, 'history.json')
  const uuid = randomUUID()
  const job: JobRecord = {
    id: uuid, kind: 'local-git-tag', action: 'tag', repository: 'ExampleOrg/demo',
    location: folder, tagOperation: {
      action: 'push', tag: 'v1.2.3', expectedLocalOid: TAG_OID
    }, tagRemoteDeleted: false, releaseWorkflowId: 7,
    phase: 'completed', progress: 100, output: [],
    requestedAt: STARTED, startedAt: STARTED, finishedAt: STARTED,
    errorCode: null, retryable: false
  }
  writeFileSync(path, JSON.stringify([job]))
  const seen: ReleaseProgressTarget[] = []
  const github = {
    repository: async () => ({} as never),
    releases: async () => [],
    workflowRuns: async () => [],
    releaseProgress: async (_owner: string, _name: string, target: ReleaseProgressTarget) => {
      seen.push(target)
      return { target, checkedAt: STARTED } as never
    }
  }
  try {
    const manager = new JobManager(path, github)
    const result = await manager.releaseProgress(uuid)
    assert.equal(result.target.tagName, 'v1.2.3')
    assert.equal(result.target.workflowId, 7)
    assert.equal(result.target.expectedTagOid, TAG_OID)
    assert.equal(seen.length, 1)
    assert.equal(seen[0].startedAt, STARTED)
    await assert.rejects(() => manager.releaseProgress(randomUUID()), /not found/)
  } finally { rmSync(folder, { recursive: true, force: true }) }
})
