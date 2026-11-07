import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ReleaseStrategyStore } from '../src/main/release-strategies'
import { validateDispatchRequest, validateReleaseStrategy } from '../src/shared/release-strategies'
import { GitHubClient } from '../src/main/github'
import { JobManager } from '../src/main/jobs'

const oid = 'a'.repeat(40)
const commit = 'b'.repeat(40)
const tag = {
  object: { sha: oid, type: 'tag' }
}
const chosen = {
  kind: 'dispatch' as const, workflowId: 42, ref: 'main'
}
const request = {
  workflowId: 42, ref: 'main', tagName: 'v1.0.0', expectedTagOid: oid,
  inputs: { version: 'v1.0.0', token: 'NEVER_PERSIST_ME' }
}

function fixture() {
  const calls: Array<{ url: string; method: string; body: unknown; authorization: string | null }> = []
  const github = new GitHubClient((async (input, options) => {
    const url = new URL(String(input))
    const method = options?.method ?? 'GET'
    const body = typeof options?.body === 'string' ? JSON.parse(options.body) : null
    calls.push({ url: url.pathname + url.search, method, body,
      authorization: new Headers(options?.headers).get('Authorization') })
    if (url.pathname.endsWith('/actions/workflows/42/dispatches') && method === 'POST') {
      return new Response(null, { status: 204 })
    }
    if (url.pathname.endsWith('/actions/workflows/42')) return Response.json({
      id: 42, name: 'Some workflow', path: '.github/workflows/test.yml', state: 'active'
    })
    if (url.pathname.endsWith('/actions/workflows')) return Response.json({
      workflows: [
        { id: 42, name: 'Some workflow', path: '.github/workflows/test.yml', state: 'active' },
        { id: 55, name: 'Archived', path: '.github/workflows/old.yaml', state: 'disabled_manually' }
      ]
    })
    if (url.pathname.endsWith('/git/ref/tags/v1.0.0')) return Response.json(tag)
    if (url.pathname.endsWith('/git/tags/' + oid)) {
      return Response.json({ object: { sha: commit, type: 'commit' } })
    }
    return new Response('{}', { status: 404 })
  }) as typeof fetch, {
    get: async () => ({ method: 'environment' as const, token: 'secret-from-main' })
  })
  return { github, calls }
}

test('strategy validation prevents arbitrary workflow IDs, refs and extra fields', () => {
  assert.deepEqual(validateReleaseStrategy({ kind: 'api' }), { kind: 'api' })
  assert.deepEqual(validateReleaseStrategy(chosen), chosen)
  for (const invalid of [
    { kind: 'api', ref: 'main' },
    { kind: 'tag-push', workflowId: 0 },
    { kind: 'tag-push', workflowId: '42' },
    { kind: 'dispatch', workflowId: 42, ref: '--upload-pack' },
    { kind: 'dispatch', workflowId: 42, ref: 'refs/heads/main' },
    { kind: 'dispatch', workflowId: 42, ref: 'foo\nbar' },
    { kind: 'dispatch', workflowId: 42, ref: 'main', inputs: {} },
    { kind: 'custom' }
  ]) assert.throws(() => validateReleaseStrategy(invalid))
})

test('workflow input values are string-only, bounded and injection-safe', () => {
  assert.deepEqual({ ...validateDispatchRequest(request).inputs }, request.inputs)
  for (const inputs of [
    { bad: { hidden: true } }, { 'secret\nname': 'value' },
    { tooLong: 'x'.repeat(1025) },
    Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`field${i}`, 'a'])),
    { token: 'line\0break' }
  ]) assert.throws(() => validateDispatchRequest({ ...request, inputs }))
  assert.throws(() => validateDispatchRequest({ ...request, expectedTagOid: 'wrong' }))
  assert.throws(() => validateDispatchRequest({ ...request, workflowId: -1 }))
  assert.throws(() => validateDispatchRequest({ ...request, unexpected: true }))
})

test('strategy settings are atomic, independent, case-insensitive and fail closed when damaged', () => {
  const folder = mkdtempSync(join(tmpdir(), 'spindle-strategy-'))
  const path = join(folder, 'release-strategies.json')
  try {
    const store = new ReleaseStrategyStore(path)
    assert.deepEqual(store.get('OtherOrg/repo'), { kind: 'api' })
    store.save('OtherOrg/repo', { kind: 'tag-push', workflowId: 42 })
    store.save('Personal/demo', chosen)
    store.save('otherorg/REPO', chosen)
    const loaded = new ReleaseStrategyStore(path)
    assert.deepEqual(loaded.get('OTHERORG/repo'), chosen)
    assert.deepEqual(loaded.get('personal/DEMO'), chosen)
    assert.equal(loaded.load().length, 2)
    assert.equal(readFileSync(path, 'utf8').includes('NEVER_PERSIST_ME'), false)
    assert.throws(() => store.save('../oops', chosen))
    writeFileSync(path, '{bad json')
    assert.throws(() => loaded.get('OtherOrg/repo'))
    assert.equal(readFileSync(path, 'utf8'), '{bad json')
  } finally { rmSync(folder, { recursive: true, force: true }) }
})

test('workflow discovery is repository-scoped and does not require a hardcoded name', async () => {
  const { github, calls } = fixture()
  const workflows = await github.workflows('OtherOrg', 'repo')
  assert.deepEqual(workflows.items.map(item => item.id), [42, 55])
  assert.equal(workflows.items[1].state, 'disabled_manually')
  assert.ok(calls[0].url.startsWith('/repos/OtherOrg/repo/actions/workflows?'))
  assert.equal((await github.releaseWorkflow('OtherOrg', 'repo', 42)).name, 'Some workflow')
  await assert.rejects(() => github.releaseWorkflow('OtherOrg', 'repo', 55))
})

test('dispatch confirms existing tag object, workflow and ref without changing tags', async () => {
  const { github, calls } = fixture()
  await assert.rejects(() => github.dispatchReleaseWorkflow('OtherOrg', 'repo',
    { ...request, expectedTagOid: commit }, new AbortController().signal), /changed since confirmation/)
  assert.equal(calls.some(call => call.method === 'POST'), false)
  await github.dispatchReleaseWorkflow('OtherOrg', 'repo', request, new AbortController().signal)
  const last = calls.at(-1)!
  assert.equal(last.method, 'POST')
  assert.equal(last.url, '/repos/OtherOrg/repo/actions/workflows/42/dispatches')
  assert.deepEqual(last.body, { ref: 'main', inputs: request.inputs })
  assert.equal(last.authorization, 'Bearer secret-from-main')
  assert.equal(calls.some(call => call.method === 'POST' && call.url.includes('/git/')), false)
})

async function settle(done: () => boolean): Promise<void> {
  for (let n = 0; n < 160; n++) {
    if (done()) return
    await new Promise<void>(resolve => setTimeout(resolve, 10))
  }
  throw new Error('Dispatch job did not settle')
}

test('Activity does not persist workflow input values, restart does not re-dispatch', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'spindle-dispatch-'))
  const path = join(folder, 'jobs.json')
  const settings = new ReleaseStrategyStore(join(folder, 'strategies.json'))
  settings.save('OtherOrg/repo', chosen)
  try {
    const { github, calls } = fixture()
    const manager = new JobManager(path, github, undefined, settings)
    const job = manager.dispatchRelease('OtherOrg', 'repo', request)
    assert.equal(JSON.stringify(job).includes('NEVER_PERSIST_ME'), false)
    assert.equal(readFileSync(path, 'utf8').includes('NEVER_PERSIST_ME'), false)
    assert.throws(() => manager.dispatchRelease('OtherOrg', 'repo', request))
    await settle(() => manager.list()[0].phase === 'completed')
    assert.equal(manager.list()[0].retryable, false)
    assert.equal(calls.filter(call => call.method === 'POST').length, 1)
    assert.equal(readFileSync(path, 'utf8').includes('NEVER_PERSIST_ME'), false)
    const restarted = new JobManager(path, github, undefined, settings)
    assert.deepEqual(restarted.list()[0], manager.list()[0])
    assert.equal(calls.filter(call => call.method === 'POST').length, 1)
  } finally { rmSync(folder, { recursive: true, force: true }) }
})

test('queued dispatch cannot outlive a changed saved strategy', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'spindle-dispatch-'))
  const path = join(folder, 'jobs.json')
  const settings = new ReleaseStrategyStore(join(folder, 'strategies.json'))
  settings.save('OtherOrg/repo', chosen)
  try {
    const { github, calls } = fixture()
    const manager = new JobManager(path, github, undefined, settings)
    manager.dispatchRelease('OtherOrg', 'repo', request)
    settings.save('OtherOrg/repo', { kind: 'api' })
    await settle(() => manager.list()[0].phase !== 'queued' && manager.list()[0].phase !== 'running')
    assert.equal(manager.list()[0].phase, 'partial')
    assert.equal(calls.some(call => call.method === 'POST'), false)
    assert.throws(() => manager.dispatchRelease('OtherOrg', 'repo', request))
  } finally { rmSync(folder, { recursive: true, force: true }) }
})
