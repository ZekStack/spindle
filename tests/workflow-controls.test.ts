import test from 'node:test'
import assert from 'node:assert/strict'
import {
  validateWorkflowControlRequest, validateDeclaredInputs,
  validateStoredWorkflowControl, workflowActionAllowed
} from '../src/shared/workflow-controls'
import type { WorkflowDispatchInput } from '../src/shared/workflow-discovery'
import { GitHubClient, WorkflowPreflightError, WorkflowMutationUncertainError } from '../src/main/github'

const SHA = 'a'.repeat(40)
const RUN_SHA = 'b'.repeat(40)
const BLOB = 'c'.repeat(40)
const prefix = '/repos/TestOrg/demo'
const source = [
  'name: Release', 'on:', '  workflow_dispatch:', '    inputs:',
  '      version:', '        required: true', '        type: choice',
  '        options: [stable, preview]',
  '      dry_run:', '        type: boolean', ''
].join('\n')
const defined: WorkflowDispatchInput[] = [
  { name: 'version', description: '', required: true, type: 'choice', options: ['stable','preview'] },
  { name: 'dry_run', description: '', required: false, type: 'boolean', options: [] }
]
const dispatch = {
  action: 'dispatch' as const, workflowId: 21, ref: 'main', refType: 'branch' as const,
  expectedRefOid: SHA, expectedDefaultBlobSha: BLOB, expectedSourceBlobSha: BLOB,
  inputs: { version: 'stable', dry_run: 'true' }
}
const runAction = {
  action: 'rerun-failed' as const, workflowId: 21, runId: 50,
  expectedHeadSha: RUN_SHA, expectedAttempt: 2,
  expectedStatus: 'completed', expectedConclusion: 'failure'
}
const workflow = {
  id: 21, path: '.github/workflows/release.yml',
  name: 'Release', state: 'active'
}
type Reply = { status?: number; body?: unknown }
function fake(routes: Record<string, Reply> = {}) {
  const sent: Array<{ method: string; path: string; body: string; headers: Headers }> = []
  const map: Record<string, Reply> = {
    [prefix]: { body: {
      id: 1, full_name: 'TestOrg/demo', name: 'demo', default_branch: 'main',
      description: null, private: false, archived: false,
      html_url: 'https://github.com/TestOrg/demo', updated_at: '2026-11-07T20:00:00Z',
      permissions: { push: true }
    } },
    [prefix + '/git/ref/heads/main']: { body: { object: { sha: SHA, type: 'commit' } } },
    [prefix + '/actions/workflows/21']: { body: workflow },
    [prefix + '/contents/.github/workflows/release.yml']: {
      body: { type: 'file', path: workflow.path, sha: BLOB,
        size: Buffer.byteLength(source), encoding: 'base64',
        content: Buffer.from(source).toString('base64') }
    },
    [prefix + '/actions/runs/50']: { body: {
      id: 50, workflow_id: 21, head_sha: RUN_SHA,
      run_attempt: 2, status: 'completed', conclusion: 'failure'
    } },
    [prefix + '/actions/workflows/21/dispatches']: { status: 204 },
    [prefix + '/actions/runs/50/cancel']: { status: 202 },
    [prefix + '/actions/runs/50/rerun']: { status: 201 },
    [prefix + '/actions/runs/50/rerun-failed-jobs']: { status: 201 },
    ...routes
  }
  const fetcher = (async (url: string | URL | Request, options?: RequestInit) => {
    const parsed = new URL(String(url))
    const method = options?.method ?? 'GET'
    sent.push({ method, path: parsed.pathname + parsed.search,
      body: typeof options?.body === 'string' ? options.body : '',
      headers: new Headers(options?.headers) })
    const reply = map[parsed.pathname]
    if (!reply) return Response.json({}, { status: 404 })
    const status = reply.status ?? 200
    if (status === 204 || status === 202 || status === 201) return new Response(null, { status })
    return Response.json(reply.body ?? {}, { status })
  }) as typeof fetch
  const client = new GitHubClient(fetcher, {
    get: async () => ({ method: 'environment' as const, token: 'SECRET_ACCESS_TOKEN' })
  })
  return { client, map, sent }
}

test('workflow controls strictly validate union shape and persisted data has no inputs', () => {
  const validated = validateWorkflowControlRequest(dispatch)
  assert.equal(validated.action, 'dispatch')
  if (validated.action !== 'dispatch') throw new Error('Expected dispatch')
  assert.deepEqual({ ...validated.inputs }, dispatch.inputs)
  assert.equal(validateWorkflowControlRequest(runAction).action, 'rerun-failed')
  const { inputs, ...safe } = dispatch
  assert.equal(validateStoredWorkflowControl(safe), true)
  assert.equal(validateStoredWorkflowControl(dispatch), false)
  for (const [index, bad] of [
    { ...dispatch, workflowId: '21' },
    { ...dispatch, ref: '../main' },
    { ...dispatch, refType: 'other' },
    { ...dispatch, expectedRefOid: 'bad' },
    { ...dispatch, inputs: { version: 'a\u0000secret' } },
    { ...dispatch, inputs: { __proto__: 'value', nested: { x: 1 } } },
    { ...dispatch, extra: 'token' },
    { ...runAction, runId: -1 },
    { ...runAction, expectedAttempt: 0 },
    { ...runAction, expectedConclusion: 1 }
  ].entries()) assert.throws(() => validateWorkflowControlRequest(bad), `Invalid input case ${index}`)
})

test('input validation rejects unknown, missing and invalid typed values', () => {
  assert.deepEqual(validateDeclaredInputs(dispatch.inputs, defined), dispatch.inputs)
  assert.throws(() => validateDeclaredInputs({}, defined), /Required/)
  assert.throws(() => validateDeclaredInputs({ version: 'wrong' }, defined), /choice/)
  assert.throws(() => validateDeclaredInputs({ version: 'stable', dry_run: 'maybe' }, defined), /boolean/)
  assert.throws(() => validateDeclaredInputs({ version: 'stable', secret: 'x' }, defined), /not declared/)
  assert.throws(() => validateDeclaredInputs({ total: 'NaN' }, [
    { name: 'total', type: 'number', required: true, description: '', options: [] }
  ]), /number/)
})
test('run cancellation and rerun eligibility uses actual remote state', () => {
  assert.equal(workflowActionAllowed('cancel','in_progress',null), true)
  assert.equal(workflowActionAllowed('cancel','completed','success'), false)
  assert.equal(workflowActionAllowed('rerun','completed','success'), true)
  assert.equal(workflowActionAllowed('rerun','in_progress',null), false)
  assert.equal(workflowActionAllowed('rerun-failed','completed','failure'), true)
  assert.equal(workflowActionAllowed('rerun-failed','completed','success'), false)
})

test('manual dispatch revalidates ref, workflow YAML and inputs before 204 acknowledgment', async () => {
  const { client, sent } = fake()
  const preview = await client.previewWorkflowDispatch('TestOrg', 'demo', 21, 'main', 'branch')
  assert.equal(preview.refOid, SHA)
  assert.equal(preview.sourceBlobSha, BLOB)
  assert.equal(preview.inputs[0].name, 'version')
  assert.ok(sent.some(call => call.path.includes('/contents/.github/workflows/release.yml') &&
    call.path.includes('ref=refs%2Fheads%2Fmain')))
  await client.mutateWorkflowControl('TestOrg', 'demo', dispatch, AbortSignal.timeout(10_000))
  const post = sent.filter(x => x.method === 'POST')
  assert.equal(post.length, 1)
  assert.equal(post[0].path, prefix + '/actions/workflows/21/dispatches')
  assert.deepEqual(JSON.parse(post[0].body), {
    ref: 'main', inputs: { version: 'stable', dry_run: 'true' }
  })
  assert.equal(post[0].headers.get('authorization'), 'Bearer SECRET_ACCESS_TOKEN')
  assert.equal(JSON.stringify(preview).includes('SECRET_ACCESS_TOKEN'), false)
})

test('stale or unauthorized dispatch does not send POST', async () => {
  for (const change of [
    { [prefix + '/git/ref/heads/main']: { body: { object: { sha: RUN_SHA, type: 'commit' } } } },
    { [prefix]: { body: { default_branch: 'main', permissions: { push: false } } } },
    { [prefix + '/contents/.github/workflows/release.yml']: { status: 404 } }
  ]) {
    const { client, sent } = fake(change)
    await assert.rejects(() =>
      client.mutateWorkflowControl('TestOrg','demo',dispatch,AbortSignal.timeout(10_000)))
    assert.equal(sent.some(x => x.method === 'POST'), false)
  }
})

test('run mutation rechecks attempt and remote status, sends only eligible endpoints', async () => {
  const { client, sent } = fake()
  await client.mutateWorkflowControl('TestOrg', 'demo', runAction, AbortSignal.timeout(10_000))
  assert.deepEqual(sent.filter(x => x.method === 'POST').map(x => x.path),
    [prefix + '/actions/runs/50/rerun-failed-jobs'])
  const denied = fake({
    [prefix + '/actions/runs/50']: { body: {
      id: 50, workflow_id: 21, head_sha: RUN_SHA,
      run_attempt: 3, status: 'completed', conclusion: 'failure'
    } }
  })
  await assert.rejects(() =>
    denied.client.mutateWorkflowControl('TestOrg','demo',runAction,AbortSignal.timeout(10_000)),
    WorkflowPreflightError)
  assert.equal(denied.sent.some(x => x.method === 'POST'), false)
  const cancel = fake({
    [prefix + '/actions/runs/50']: { body: {
      id: 50, workflow_id: 21, head_sha: RUN_SHA,
      run_attempt: 2, status: 'in_progress', conclusion: null
    } }
  })
  await cancel.client.mutateWorkflowControl('TestOrg','demo', {
    ...runAction, action: 'cancel', expectedStatus: 'in_progress',
    expectedConclusion: null
  }, AbortSignal.timeout(10_000))
  assert.equal(cancel.sent.find(x => x.method === 'POST')?.path,
    prefix + '/actions/runs/50/cancel')
  await client.mutateWorkflowControl('TestOrg','demo', {
    ...runAction, action: 'rerun'
  }, AbortSignal.timeout(10_000))
  assert.equal(sent.filter(x => x.method === 'POST').length, 2)
})

test('definite rejection is distinct from ambiguous mutation acceptance', async () => {
  const rejected = fake({ [prefix + '/actions/runs/50/rerun-failed-jobs']: { status: 403 } })
  await assert.rejects(() =>
    rejected.client.mutateWorkflowControl('TestOrg','demo',runAction,AbortSignal.timeout(10_000)),
    WorkflowPreflightError)
  const uncertain = fake({ [prefix + '/actions/runs/50/rerun-failed-jobs']: { status: 500 } })
  await assert.rejects(() =>
    uncertain.client.mutateWorkflowControl('TestOrg','demo',runAction,AbortSignal.timeout(10_000)),
    WorkflowMutationUncertainError)
})

test('branch and tag with colliding names are inspected through explicit qualified refs', async () => {
  const { client, sent } = fake({
    [prefix + '/git/ref/tags/main']: { body: { object: { sha: SHA, type: 'tag' } } }
  })
  const tagged = await client.previewWorkflowDispatch('TestOrg', 'demo', 21, 'main', 'tag')
  assert.equal(tagged.refType, 'tag')
  assert.ok(sent.some(call => call.path.includes('/contents/.github/workflows/release.yml') &&
    call.path.includes('ref=refs%2Ftags%2Fmain')))
  assert.ok(sent.some(call => call.path.includes('/contents/.github/workflows/release.yml') &&
    call.path.includes('ref=refs%2Fheads%2Fmain')))
})
