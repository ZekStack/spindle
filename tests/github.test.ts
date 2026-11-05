import test from 'node:test'
import assert from 'node:assert/strict'
import { GitHubClient } from '../src/main/github'

const repo = {
  id: 7, full_name: 'OtherOrg/repo', name: 'repo',
  description: 'Demo', private: true, archived: false,
  default_branch: 'main', updated_at: '2026-11-04T07:00:00Z',
  html_url: 'https://github.com/OtherOrg/repo'
}
function mockGithub(responses: Record<string, unknown>, authenticated = true) {
  const seen: { url: string; auth?: string }[] = []
  const fetcher = (async (url: string | URL | Request, options?: RequestInit) => {
    const request = new URL(String(url))
    seen.push({ url: request.toString(),
      auth: new Headers(options?.headers).get('Authorization') ?? undefined })
    const data = responses[request.pathname]
    return data === undefined
      ? new Response('{}', { status: 404 })
      : Response.json(data)
  }) as typeof fetch
  const client = new GitHubClient(fetcher, {
    get: async () => authenticated
      ? { token: 'fake-token', method: 'environment' as const }
      : { method: 'anonymous' as const }
  })
  return { client, seen }
}
test('discovers arbitrary GitHub organizations and repositories without an allowlist', async () => {
  const { client, seen } = mockGithub({
    '/orgs/OtherOrg': { login: 'OtherOrg', name: 'Other Org', avatar_url: '', html_url: 'https://github.com/OtherOrg', public_repos: 3, description: null },
    '/orgs/OtherOrg/repos': [repo]
  })
  assert.equal((await client.organization('OtherOrg')).name, 'Other Org')
  const results = await client.repositories('OtherOrg', 2)
  assert.equal(results[0].fullName, 'OtherOrg/repo')
  assert.equal(results[0].private, true)
  assert.match(seen[1].url, /page=2/)
  assert.equal(seen[1].auth, 'Bearer fake-token')
  assert.deepEqual(await client.authStatus(), { method: 'environment' })
})
test('maps releases and workflow statuses without guessing release completion', async () => {
  const { client } = mockGithub({
    '/repos/OtherOrg/repo': repo,
    '/repos/OtherOrg/repo/releases': [{ id: 11, tag_name: 'v1.0.0', name: 'Release 1', draft: false, prerelease: false, published_at: '2026-11-04T08:00:00Z', html_url: 'https://github.com/OtherOrg/repo/releases/tag/v1.0.0' }],
    '/repos/OtherOrg/repo/actions/runs': { workflow_runs: [
      { id: 3, name: 'Build', event: 'push', status: 'in_progress', conclusion: null, head_branch: 'main', created_at: '2026-11-04T08:00:00Z', html_url: 'https://github.com/OtherOrg/repo/actions/runs/3' }
    ] }
  })
  assert.equal((await client.repository('OtherOrg', 'repo')).defaultBranch, 'main')
  assert.equal((await client.releases('OtherOrg', 'repo'))[0].tagName, 'v1.0.0')
  const [run] = await client.workflowRuns('OtherOrg', 'repo')
  assert.equal(run.status, 'in_progress')
  assert.equal(run.conclusion, null)
})
test('distinguishes inaccessible GitHub resources and does not expose credentials', async () => {
  const { client, seen } = mockGithub({}, false)
  await assert.rejects(() => client.organization('NoAccess'), /inaccessible/i)
  assert.equal(seen[0].auth, undefined)
  assert.deepEqual(await client.authStatus(), { method: 'anonymous' })
})

test('current identity resolves GitHub viewer and reported OAuth scopes without exposing tokens', async () => {
  const calls: string[] = []
  const token = 'ghp_SUPERSECRET'
  const fetcher = (async (_url: string | URL | Request, options?: RequestInit) => {
    calls.push(new Headers(options?.headers).get('Authorization') || '')
    return Response.json({
      login: 'ExampleUser', name: 'Example User',
      avatar_url: 'https://avatars.githubusercontent.com/u/7?v=4',
      html_url: 'https://github.com/ExampleUser'
    }, { headers: { 'x-oauth-scopes': 'repo, read:org' } })
  }) as typeof fetch
  const client = new GitHubClient(fetcher, {
    get: async () => ({ method: 'environment' as const, token })
  })
  assert.deepEqual(await client.identity(), {
    method: 'environment', state: 'authenticated',
    account: {
      login: 'ExampleUser', name: 'Example User',
      avatarUrl: 'https://avatars.githubusercontent.com/u/7?v=4',
      htmlUrl: 'https://github.com/ExampleUser'
    },
    scopes: ['repo', 'read:org']
  })
  assert.equal(calls[0], 'Bearer ' + token)
  assert.equal(JSON.stringify(await client.identity()).includes(token), false)
})

test('identity distinguishes anonymous, invalid, forbidden and rate-limited credentials', async () => {
  const noCredentials = mockGithub({}, false)
  assert.deepEqual(await noCredentials.client.identity(), {
    method: 'anonymous', state: 'anonymous', account: null, scopes: null
  })
  assert.equal(noCredentials.seen.length, 0)
  for (const [code, remaining, expected] of [
    [401, '42', 'invalid'],
    [403, '0', 'rate-limited'],
    [403, '42', 'forbidden'],
    [500, '42', 'unavailable']
  ] as const) {
    const client = new GitHubClient(
      (async () => new Response('{}', {
        status: code, headers: { 'x-ratelimit-remaining': remaining }
      })) as typeof fetch,
      { get: async () => ({ method: 'environment' as const, token: 'SECRET' }) }
    )
    const result = await client.identity()
    assert.equal(result.state, expected)
    assert.equal(result.account, null)
    assert.equal(JSON.stringify(result).includes('SECRET'), false)
  }
})

test('identity refresh clears cached CLI credentials without changing global login', async () => {
  let invalidations = 0
  const client = new GitHubClient(
    (async () => Response.json({ login: 'new-user', name: null })) as typeof fetch,
    {
      get: async () => ({ method: 'github-cli' as const, token: 'hidden' }),
      invalidate: () => { invalidations++ }
    }
  )
  assert.equal((await client.identity()).state, 'authenticated')
  assert.equal(invalidations, 0)
  assert.equal((await client.identity(true)).account?.login, 'new-user')
  assert.equal(invalidations, 1)
})

test('repository and organization discovery use scoped, validated GitHub search endpoints', async () => {
  const { client, seen } = mockGithub({
    '/search/repositories': { items: [repo] },
    '/search/users': { items: [{ login: 'OtherOrg', avatar_url: null }] }
  })
  const results = await client.searchRepositories('repo', 2)
  assert.equal(results[0].fullName, 'OtherOrg/repo')
  assert.equal(results[0].private, true)
  assert.equal(seen[0].auth, 'Bearer fake-token')
  const query = new URL(seen[0].url).searchParams
  assert.equal(query.get('q'), 'repo in:name')
  assert.equal(query.get('page'), '2')
  assert.equal((await client.searchOrganizations('Other', 1))[0].login, 'OtherOrg')
  assert.equal(new URL(seen[1].url).searchParams.get('q'), 'Other in:login type:org')
  assert.equal(seen[1].auth, 'Bearer fake-token')
})

test('GitHub search input cannot inject API qualifiers or unrestricted URLs', async () => {
  const { client, seen } = mockGithub({})
  for (const bad of ['x', 'repo type:user', 'x?q=token', '../private', 'owner/repo', 'a'.repeat(81)]) {
    await assert.rejects(() => client.searchRepositories(bad, 1))
  }
  for (const bad of ['a', '../x', 'org type:user']) {
    await assert.rejects(() => client.searchOrganizations(bad, 1))
  }
  await assert.rejects(() => client.searchRepositories('repo', 0))
  assert.equal(seen.length, 0)
})
