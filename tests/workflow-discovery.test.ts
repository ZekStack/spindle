import test from 'node:test'
import assert from 'node:assert/strict'
import { GitHubClient } from '../src/main/github'
import { decodeWorkflowContent, parseWorkflowDefinition } from '../src/main/workflow-definition'
import { validateWorkflowPage, validateRunsFilter } from '../src/shared/workflow-discovery'

const example = [
  'name: Build and publish',
  'on:',
  '  push:',
  '    tags: ["v*"]',
  '    branches-ignore: [temporary]',
  '  workflow_dispatch:',
  '    inputs:',
  '      version:',
  '        type: choice',
  '        description: Release version',
  '        required: true',
  '        options: [stable, prerelease]',
  '      verbose:',
  '        type: boolean',
  '  schedule:',
  '    - cron: "0 3 * * 1"',
  'permissions:',
  '  contents: write',
  '  actions: read',
  'jobs:',
  '  package:',
  '    permissions:',
  '      contents: read',
  '  publish:',
  '    permissions: write-all',
  ''
].join('\n')

test('parses YAML triggers, dispatch inputs and permission overrides', () => {
  const value = parseWorkflowDefinition(example)
  assert.deepEqual(value.triggers.map(trigger => trigger.event),
    ['push', 'workflow_dispatch', 'schedule'])
  assert.ok(value.triggers[0].filters.some(filter => filter.includes('tags: v*')))
  assert.equal(value.triggers[2].complex, false)
  assert.equal(value.triggers[2].filters[0], 'cron: 0 3 * * 1')
  assert.deepEqual(value.dispatchInputs.map(input => input.name), ['version','verbose'])
  assert.deepEqual(value.dispatchInputs[0].options, ['stable', 'prerelease'])
  assert.equal(value.dispatchInputs[0].required, true)
  assert.equal(value.permissions.mode, 'explicit')
  assert.deepEqual(value.permissions.entries, [
    { scope: 'contents', access: 'write' },
    { scope: 'actions', access: 'read' }
  ])
  assert.equal(value.jobPermissions[0].permissions.entries[0].access, 'read')
  assert.equal(value.jobPermissions[1].permissions.mode, 'write-all')
})

test('safe YAML inspection does not guess inherited permissions or evaluate expressions', () => {
  const triggers = parseWorkflowDefinition('on: [push, pull_request]\njobs: {}\n')
  assert.deepEqual(triggers.triggers.map(item => item.event), ['push', 'pull_request'])
  assert.equal(triggers.permissions.mode, 'unspecified')
  assert.equal(parseWorkflowDefinition('on: workflow_dispatch\npermissions: read-all\n')
    .permissions.mode, 'read-all')
  const dynamic = parseWorkflowDefinition(
    'on:\n  push:\n    branches: "${{ inputs.branch }}"\npermissions:\n  contents: "${{ inputs.mode }}"\n')
  assert.equal(dynamic.triggers[0].filters[0].includes('inputs.branch'), true)
  assert.equal(dynamic.permissions.entries[0].access, 'dynamic')
  assert.throws(() => parseWorkflowDefinition('on: [push\n'))
  assert.throws(() => parseWorkflowDefinition('x'.repeat(128 * 1024 + 1)), /too large/)
})

test('workflow source decoding validates bytes, base64 and UTF8', () => {
  const bytes = Buffer.from(example)
  assert.equal(decodeWorkflowContent({
    encoding: 'base64', size: bytes.length, content: bytes.toString('base64')
  }), example)
  assert.throws(() => decodeWorkflowContent({ encoding: 'none', size: 1, content: 'YQ==' }))
  assert.throws(() => decodeWorkflowContent({ encoding: 'base64', size: 1, content: 'bad!' }))
  assert.throws(() => decodeWorkflowContent({ encoding: 'base64', size: 1, content: 'YQBi' }))
  assert.throws(() => decodeWorkflowContent({
    encoding: 'base64', size: 1, content: Buffer.from([255]).toString('base64')
  }))
})

test('workflow pagination and filter validation reject unsafe query values', () => {
  assert.equal(validateWorkflowPage(1), 1)
  for (const invalid of [-1, 0, 1001, 1.5, '1']) {
    assert.throws(() => validateWorkflowPage(invalid))
  }
  assert.deepEqual(validateRunsFilter({
    page: 2, event: 'workflow_dispatch', branch: 'release/v1.0', status: 'failure'
  }), {
    page: 2, event: 'workflow_dispatch', branch: 'release/v1.0', status: 'failure'
  })
  for (const invalid of [
    { page: 1, event: 'push&per_page=999' },
    { page: 1, branch: 'main?token=secret' },
    { page: 1, status: 'invalid' },
    { page: 1, unexpected: true }
  ]) assert.throws(() => validateRunsFilter(invalid))
})

const prefix = '/repos/ExampleOrg/example'
const workflow = {
  id: 42, name: 'Custom workflow', path: '.github/workflows/custom.yaml', state: 'active'
}
const repoData = {
  id: 1, full_name: 'ExampleOrg/example', name: 'example',
  description: null, private: false, archived: false,
  default_branch: 'main', updated_at: '2026-11-07T18:00:00Z',
  html_url: 'https://github.com/ExampleOrg/example'
}
type MockRoute = { body?: unknown; status?: number; next?: boolean }
function fixture(overrides: Record<string, MockRoute> = {}) {
  const seen: URL[] = []
  const routes: Record<string, MockRoute> = {
    [prefix]: { body: repoData },
    [prefix + '/actions/workflows']: { body: {
      total_count: 51, workflows: [workflow, {
        id: 57, name: 'Disabled', path: '.github/workflows/disabled.yml',
        state: 'disabled_manually'
      }]
    }, next: true },
    [prefix + '/actions/workflows/42']: { body: workflow },
    [prefix + '/contents/.github/workflows/custom.yaml']: { body: {
      type: 'file', path: workflow.path, sha: 'd'.repeat(40),
      size: Buffer.byteLength(example),
      encoding: 'base64', content: Buffer.from(example).toString('base64')
    } },
    [prefix + '/actions/workflows/42/runs']: { body: {
      total_count: 31, workflow_runs: [{
        id: 700, workflow_id: 42, name: 'Custom workflow',
        run_number: 18, run_attempt: 2, event: 'workflow_dispatch',
        status: 'completed', conclusion: 'success', head_branch: 'main',
        head_sha: 'a'.repeat(40),
        created_at: '2026-11-07T18:00:00Z', updated_at: '2026-11-07T18:03:00Z',
        html_url: 'https://github.com/ExampleOrg/example/actions/runs/700'
      }]
    }, next: true },
    ...overrides
  }
  const client = new GitHubClient((async (input) => {
    const url = new URL(String(input))
    seen.push(url)
    const reply = routes[url.pathname]
    if (!reply) return Response.json({}, { status: 404 })
    if (reply.status === 404) return Response.json({}, { status: 404 })
    return Response.json(reply.body ?? {}, {
      status: reply.status ?? 200,
      headers: reply.next
        ? { link: '<https://api.github.com/example?page=2>; rel="next"' } : {}
    })
  }) as typeof fetch, {
    get: async () => ({ method: 'environment' as const, token: 'SECRET' })
  })
  return { client, seen }
}

test('catalog uses pagination and discovers arbitrary workflow names/states', async () => {
  const { client, seen } = fixture()
  const catalog = await client.workflowCatalog('ExampleOrg', 'example', 1)
  assert.equal(catalog.items.length, 2)
  assert.equal(catalog.items[1].state, 'disabled_manually')
  assert.equal(catalog.totalCount, 51)
  assert.equal(catalog.hasNext, true)
  assert.equal(seen[0].searchParams.get('page'), '1')
  assert.equal(seen[0].searchParams.get('per_page'), '50')
  assert.equal(JSON.stringify(catalog).includes('SECRET'), false)
})

test('workflow file is read from repository default branch only', async () => {
  const { client, seen } = fixture()
  const details = await client.workflowSource('ExampleOrg', 'example', 42)
  assert.equal(details.sourceState, 'parsed')
  assert.equal(details.fileBlobSha, 'd'.repeat(40))
  assert.equal(details.branch, 'main')
  assert.equal(details.dispatchInputs[0].name, 'version')
  assert.ok(seen.some(url => url.pathname.endsWith('/contents/.github/workflows/custom.yaml') &&
    url.searchParams.get('ref') === 'main'))
})

test('missing, malformed and inaccessible workflow file is not interpreted as no triggers', async () => {
  const missing = fixture({
    [prefix + '/contents/.github/workflows/custom.yaml']: { status: 404 }
  })
  const state = await missing.client.workflowSource('ExampleOrg', 'example', 42)
  assert.equal(state.sourceState, 'unavailable')
  assert.deepEqual(state.triggers, [])
  const invalid = fixture({
    [prefix + '/contents/.github/workflows/custom.yaml']: { body: {
      type: 'file', path: workflow.path, sha: 'a'.repeat(40),
      size: 4, encoding: 'base64', content: 'bad!'
    } }
  })
  assert.equal((await invalid.client.workflowSource('ExampleOrg', 'example', 42))
    .sourceState, 'invalid')
})

test('workflow runs expose exact commit and apply validated server filters', async () => {
  const { client, seen } = fixture()
  const result = await client.workflowRunPage('ExampleOrg', 'example', 42, {
    page: 2, branch: 'main', event: 'workflow_dispatch', status: 'success'
  })
  assert.equal(result.items[0].headSha, 'a'.repeat(40))
  assert.equal(result.items[0].attempt, 2)
  assert.equal(result.totalCount, 31)
  assert.equal(result.hasNext, true)
  const query = seen[0].searchParams
  assert.equal(query.get('branch'), 'main')
  assert.equal(query.get('event'), 'workflow_dispatch')
  assert.equal(query.get('status'), 'success')
  assert.equal(query.get('page'), '2')
  await assert.rejects(() => client.workflowRunPage('ExampleOrg', 'example', 42, {
    page: 1, branch: 'main&admin=true'
  }))
})
