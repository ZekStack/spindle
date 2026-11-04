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
