import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GitHubClient } from '../src/main/github'
import { validateReleaseMutation } from '../src/shared/releases'
import { JobManager } from '../src/main/jobs'

const oid = 'a'.repeat(40)
const commit = 'b'.repeat(40)
const stamp = '2026-11-07T12:34:56Z'
const release = {
  id: 7, tag_name: 'v1.0.0', name: 'Release', body: 'Original notes',
  draft: true, prerelease: false, immutable: false,
  published_at: null, updated_at: stamp,
  html_url: 'https://github.com/OtherOrg/repo/releases/tag/v1.0.0',
  assets: [{ id: 8, name: 'existing.zip', state: 'uploaded', size: 2 }]
}

function fixture(overrides: Record<string, unknown> = {}) {
  const calls: Array<{ path: string; method: string; body?: unknown; auth: string | null }> = []
  const paths: Record<string, unknown> = {
    '/repos/OtherOrg/repo/git/ref/tags/v1.0.0': { object: { sha: oid, type: 'tag' } },
    [`/repos/OtherOrg/repo/git/tags/${oid}`]: { object: { sha: commit, type: 'commit' } },
    '/repos/OtherOrg/repo/releases/7': release,
    '/repos/OtherOrg/repo/releases': { id: 7 },
    '/repos/OtherOrg/repo/releases/7/assets': { id: 9, name: 'asset.zip' },
    ...overrides
  }
  const requestFn = (async (input: string | URL | Request, options?: RequestInit) => {
    const url = new URL(String(input))
    const method = options?.method ?? 'GET'
    let body: unknown = undefined
    if (typeof options?.body === 'string') body = JSON.parse(options.body)
    if (options?.body && typeof options.body !== 'string') body = options.body
    calls.push({ path: url.pathname + url.search, method, body,
      auth: new Headers(options?.headers).get('Authorization') })
    if (method === 'DELETE') return new Response(null, { status: 204 })
    const value = paths[url.pathname]
    if (value === undefined) return new Response('{}', { status: 404 })
    return Response.json(value, { status: method === 'POST' ? 201 : 200 })
  }) as typeof fetch
  return { github: new GitHubClient(requestFn, {
    get: async () => ({ method: 'environment' as const, token: 'fakeSECRET' })
  }), calls }
}

const safe = { tagName: 'v1.0.0', expectedTagOid: oid }
const selected = { ...safe, releaseId: 7, expectedUpdatedAt: stamp }

test('release action IPC validation rejects forged IDs, tag names, notes and mutation fields', () => {
  assert.deepEqual(validateReleaseMutation({
    action: 'create-draft', ...safe, name: 'Test', body: 'Notes'
  }), { action: 'create-draft', ...safe, name: 'Test', body: 'Notes' })
  for (const bad of [
    { action: 'create-draft', ...safe, expectedTagOid: null, name: 'Test', body: '' },
    { action: 'create-draft', ...safe, name: '', body: '' },
    { action: 'create-draft', ...safe, name: 'Test', body: 'a'.repeat(64001) },
    { action: 'create-draft', ...safe, name: 'Test', body: 'abc\0' },
    { action: 'publish', ...selected },
    { action: 'publish', ...selected, prerelease: 'false' },
    { action: 'edit-notes', ...selected, body: '' },
    { action: 'delete-release', ...selected, name: 'surprise' },
    { action: 'upload-asset', ...safe },
    { action: 'upload-asset', ...selected, expectedUpdatedAt: 'invalid' },
    { action: 'delete-release', ...selected, releaseId: -1 },
    { action: 'delete-release', ...selected, tagName: 'refs/tags/v1' },
    { action: 'delete-release', ...selected, expectedTagOid: 'wrong' },
    { action: 'missing', ...selected }
  ]) assert.throws(() => validateReleaseMutation(bad))
})

test('draft creation verifies annotated tag object and commit; never creates the tag itself', async () => {
  const { github, calls } = fixture()
  const tag = await github.releaseTag('OtherOrg', 'repo', 'v1.0.0')
  assert.deepEqual(tag, { name: 'v1.0.0', tagOid: oid, commitSha: commit })
  await assert.rejects(github.mutateRelease('OtherOrg', 'repo', {
    action: 'create-draft', tagName: 'v1.0.0', expectedTagOid: commit,
    name: 'New release', body: ''
  }, new AbortController().signal), /changed since confirmation/i)
  assert.equal(calls.filter(c => c.method === 'POST').length, 0)
  await github.mutateRelease('OtherOrg', 'repo', {
    action: 'create-draft', ...safe, name: 'New release', body: 'New notes'
  }, new AbortController().signal)
  assert.deepEqual(calls.find(c => c.method === 'POST')?.body, {
    tag_name: 'v1.0.0', name: 'New release', body: 'New notes',
    draft: true, prerelease: false, make_latest: 'false'
  })
  assert.equal(calls.some(c => c.path.includes('/git/refs') && c.method !== 'GET'), false)
  assert.equal(calls.at(-1)?.auth, 'Bearer fakeSECRET')
})

test('release details return verified commit SHA and distinguish tag object from commit', async () => {
  const { github } = fixture()
  const details = await github.releaseDetails('OtherOrg', 'repo', 7)
  assert.equal(details.commitSha, commit)
  assert.equal(details.tagOid, oid)
  assert.equal(details.assets.length, 1)
  assert.equal(details.draft, true)
})

test('edits, publication and deletion require live tag and release revision confirmation', async () => {
  const { github, calls } = fixture()
  await assert.rejects(github.mutateRelease('OtherOrg', 'repo', {
    action: 'delete-release', ...selected, expectedUpdatedAt: '2026-11-06T12:34:56Z'
  }, new AbortController().signal), /changed since confirmation/)
  assert.equal(calls.some(c => c.method === 'DELETE'), false)
  await github.mutateRelease('OtherOrg', 'repo', {
    action: 'edit-notes', ...selected, name: 'Updated', body: 'New notes'
  }, new AbortController().signal)
  assert.deepEqual(calls.at(-1)?.body, { name: 'Updated', body: 'New notes' })
  await github.mutateRelease('OtherOrg', 'repo', {
    action: 'publish', ...selected, prerelease: true
  }, new AbortController().signal)
  assert.deepEqual(calls.at(-1)?.body,
    { draft: false, prerelease: true, make_latest: 'false' })
  await github.mutateRelease('OtherOrg', 'repo', {
    action: 'delete-release', ...selected
  }, new AbortController().signal)
  assert.match(calls.at(-1)!.path, /releases\/7$/)
  assert.equal(calls.at(-1)!.method, 'DELETE')
})

test('published or immutable releases are never accidentally republished or mutated', async () => {
  const { github } = fixture({ '/repos/OtherOrg/repo/releases/7': {
    ...release, draft: false
  } })
  await assert.rejects(github.mutateRelease('OtherOrg', 'repo', {
    action: 'publish', ...selected, prerelease: false
  }, new AbortController().signal), /Only a draft/)
  const immutable = fixture({ '/repos/OtherOrg/repo/releases/7': {
    ...release, immutable: true
  } })
  await assert.rejects(immutable.github.mutateRelease('OtherOrg', 'repo', {
    action: 'edit-notes', ...selected, name: 'A', body: ''
  }, new AbortController().signal), /immutable/)
})

test('asset uploads reject duplicate names, oversized files, and never send arbitrary paths over IPC', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'spindle-release-'))
  try {
    writeFileSync(join(tmp, 'existing.zip'), 'same')
    writeFileSync(join(tmp, 'new.zip'), 'new')
    const { github, calls } = fixture()
    await assert.rejects(github.mutateRelease('OtherOrg', 'repo', {
      action: 'upload-asset', ...selected
    }, new AbortController().signal, join(tmp, 'existing.zip')), /already exists/)
    assert.equal(calls.some(c => c.method === 'POST'), false)
    await github.mutateRelease('OtherOrg', 'repo', {
      action: 'upload-asset', ...selected
    }, new AbortController().signal, join(tmp, 'new.zip'))
    assert.equal(calls.at(-1)?.method, 'POST')
    assert.match(calls.at(-1)!.path, /assets\?name=new.zip$/)
  } finally { rmSync(tmp, { recursive: true, force: true }) }
})

test('Activity never persists release notes or asset file paths and treats restart as uncertain', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'spindle-jobs-release-'))
  const file = join(tmp, 'jobs.json')
  try {
    const { github } = fixture()
    const mgr = new JobManager(file, github)
    const job = mgr.mutateRelease('OtherOrg', 'repo', {
      action: 'create-draft', ...safe, name: 'secret title', body: 'secret notes'
    })
    assert.equal(job.releaseOperation?.action, 'create-draft')
    assert.equal(JSON.stringify(job).includes('secret'), false)
    assert.equal(readFileSync(file, 'utf8').includes('secret'), false)
    // A new instance loading a queued/running operation must not retry blindly.
    const restarted = new JobManager(file, github)
    const recovered = restarted.list().find(item => item.id === job.id)
    assert.ok(recovered)
    assert.ok(['interrupted', 'partial'].includes(recovered.phase))
    assert.equal(recovered.retryable, false)
  } finally { rmSync(tmp, { recursive: true, force: true }) }
})
