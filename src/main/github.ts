import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { managedGitHubToken } from './managed-token'
import {
  LOGIN_PATTERN, validateLogin, validatePage, validateRepository, validateRepositorySearch,
  validateOrganizationSearch,
  type AuthStatus, type GitHubIdentity, type Organization, type OrganizationSuggestion,
  type PageResult, type Release, type Repository, type WorkflowRun
} from '../shared/contracts'

const execFileAsync = promisify(execFile)
const BASE = 'https://api.github.com'
type RequestFn = typeof fetch
type Credentials = { token?: string; method: AuthStatus['method'] }

export class GitHubCredentials {
  private cache: { value: Credentials; until: number } | null = null
  async get(): Promise<Credentials> {
    // A deliberate in-app sign-in owns the active identity, but never
    // modifies the user's external GitHub CLI or environment credentials.
    const managed = await managedGitHubToken.load()
    if (managed) return { token: managed, method: 'spindle' }
    const env = (process.env.GH_TOKEN || process.env.GITHUB_TOKEN)?.trim()
    if (env) return { token: env, method: 'environment' }
    if (this.cache && Date.now() < this.cache.until) return this.cache.value
    let value: Credentials = { method: 'anonymous' }
    try {
      const { stdout } = await execFileAsync('gh', ['auth', 'token'], {
        timeout: 3_000, maxBuffer: 8_192, windowsHide: true,
        env: { ...process.env, GH_PROMPT_DISABLED: '1' }
      })
      const token = stdout.trim()
      if (token) value = { token, method: 'github-cli' }
    } catch { /* gh is optional; unauthenticated public browsing is supported. */ }
    this.cache = { value, until: Date.now() + 30_000 }
    return value
  }
  invalidate(): void { this.cache = null }
}

export class GitHubClient {
  constructor(
    private readonly requestFn: RequestFn = fetch,
    private readonly credentials: {
      get(): Promise<Credentials>
      invalidate?(): void
    } = new GitHubCredentials()
  ) {}
  async authStatus(): Promise<AuthStatus> {
    return { method: (await this.credentials.get()).method }
  }

  /** Resolve the current viewer without crossing IPC with credentials or raw errors. */
  async identity(refresh = false): Promise<GitHubIdentity> {
    if (refresh) this.credentials.invalidate?.()
    let method: AuthStatus['method'] = 'anonymous'
    const state = (
      kind: GitHubIdentity['state']
    ): GitHubIdentity => ({ method, state: kind, account: null, scopes: null })
    try {
      const credentials = await this.credentials.get()
      method = credentials.method
      if (!credentials.token) return state('anonymous')
      const response = await this.requestFn(BASE + '/user', {
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'Spindle-Desktop',
          Authorization: `Bearer ${credentials.token}`
        },
        signal: AbortSignal.timeout(12_000)
      })
      if (response.status === 401) return state('invalid')
      if (response.status === 403) {
        return state(response.headers.get('x-ratelimit-remaining') === '0'
          ? 'rate-limited' : 'forbidden')
      }
      if (!response.ok) return state('unavailable')
      const viewer = await response.json() as {
        login?: unknown; name?: unknown; avatar_url?: unknown
      }
      if (typeof viewer.login !== 'string' ||
          !LOGIN_PATTERN.test(viewer.login)) {
        return state('unavailable')
      }
      const avatar = typeof viewer.avatar_url === 'string' &&
        /^https:\/\/avatars\.githubusercontent\.com\//.test(viewer.avatar_url)
        ? viewer.avatar_url : null
      const scopeHeader = response.headers.get('x-oauth-scopes')
      const scopes = scopeHeader === null ? null : scopeHeader.split(',')
        .map((scope) => scope.trim())
        .filter((scope) => /^[a-zA-Z0-9:_-]{1,64}$/.test(scope))
        .slice(0, 32)
      if (method === 'spindle' && this.credentials instanceof GitHubCredentials) {
        // Older installs contain a single encrypted token without its login.
        // Associate it with GitHub's verified identity, without exposing it.
        await managedGitHubToken.adoptLegacy(viewer.login).catch(() => {})
      }
      return {
        method, state: 'authenticated',
        account: {
          login: viewer.login,
          name: typeof viewer.name === 'string' ? viewer.name.slice(0, 120) : null,
          avatarUrl: avatar,
          htmlUrl: `https://github.com/${viewer.login}`
        },
        scopes
      }
    } catch {
      // Timeouts, offline state and invalid JSON must never expose request
      // headers, tokens or token-bearing URLs to the renderer.
      return state('unavailable')
    }
  }
  private async request<T>(path: string, signal?: AbortSignal): Promise<T> {
    return (await this.requestWithMeta<T>(path, signal)).data
  }

  private async requestWithMeta<T>(path: string, signal?: AbortSignal): Promise<{ data: T; hasNext: boolean }> {
    const creds = await this.credentials.get()
    let response: Response
    try {
      response = await this.requestFn(BASE + path, {
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'Spindle-Desktop',
          ...(creds.token ? { Authorization: `Bearer ${creds.token}` } : {})
        },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12_000)]) : AbortSignal.timeout(12_000)
      })
    } catch {
      // Never forward raw fetch errors: they may contain request details.
      throw new Error('GitHub connection failed. Check your network and retry.')
    }
    if (!response.ok) {
      const limited = response.status === 429 ||
        (response.status === 403 &&
          (response.headers.get('x-ratelimit-remaining') === '0' ||
           response.headers.has('retry-after')))
      if (limited) {
        const seconds = Number(response.headers.get('retry-after'))
        const wait = Number.isInteger(seconds) && seconds > 0 && seconds <= 3600
          ? ` Retry after ${seconds} seconds.` : ''
        throw new Error(`GitHub API rate limit reached.${wait} Try again later.`)
      }
      if (response.status === 401) throw new Error(
        'GitHub authentication expired or is invalid. Switch or reconnect your account.')
      if (response.status === 403) throw new Error(
        'GitHub denied this account access. Check repository permissions or switch accounts.')
      if (response.status === 404) throw new Error(
        'GitHub resource not found or inaccessible to the selected account.')
      if (response.status >= 500) throw new Error(
        'GitHub service is temporarily unavailable. Retry shortly.')
      throw new Error(`GitHub request failed (HTTP ${response.status})`)
    }
    const link = response.headers.get('link') || ''
    const hasNext = link.split(',').some((part) => /rel="next"/.test(part))
    return { data: await response.json() as T, hasNext }
  }

  async organization(value: string): Promise<Organization> {
    const login = validateLogin(value)
    const org = await this.request<{
      login: string; name: string | null; avatar_url: string;
      description: string | null; html_url: string; public_repos: number
    }>(`/orgs/${encodeURIComponent(login)}`)
    return { login: org.login, name: org.name, avatarUrl: org.avatar_url,
      description: org.description, htmlUrl: org.html_url, publicRepos: org.public_repos }
  }
  async listAccessibleOrganizations(pageValue: number): Promise<PageResult<OrganizationSuggestion>> {
    const page = validatePage(pageValue)
    if (!(await this.credentials.get()).token) {
      throw new Error('Sign in to GitHub to discover your organizations.')
    }
    const { data, hasNext } = await this.requestWithMeta<
      Array<{ login: string; avatar_url: string | null }>
    >(`/user/orgs?per_page=100&page=${page}`)
    return {
      items: data.filter((org) => typeof org.login === 'string' &&
        LOGIN_PATTERN.test(org.login))
        .map((org) => ({ login: org.login, avatarUrl: org.avatar_url })),
      hasNext
    }
  }

  async searchOrganizations(queryValue: string, pageValue: number): Promise<PageResult<OrganizationSuggestion>> {
    const query = validateOrganizationSearch(queryValue)
    const page = validatePage(pageValue)
    const q = encodeURIComponent(`${query} in:login type:org`)
    const { data, hasNext } = await this.requestWithMeta<{
      total_count?: number
      items: Array<{ login: string; avatar_url: string | null }>
    }>(`/search/users?q=${q}&per_page=20&page=${page}`)
    return {
      items: data.items.filter((item) => typeof item.login === 'string' &&
        LOGIN_PATTERN.test(item.login))
        .map((item) => ({ login: item.login, avatarUrl: item.avatar_url })),
      hasNext: searchHasNext(hasNext, data.total_count, page, 20),
      totalCount: data.total_count
    }
  }

  async repositories(value: string, pageValue: number): Promise<PageResult<Repository>> {
    const org = validateLogin(value)
    const page = validatePage(pageValue)
    const { data, hasNext } = await this.requestWithMeta<RemoteRepository[]>(
      `/orgs/${encodeURIComponent(org)}/repos?per_page=100&page=${page}&sort=full_name&direction=asc&type=all`
    )
    return { items: data.map(toRepository), hasNext }
  }

  async searchOrganizationRepositories(
    value: string, queryValue: string, pageValue: number
  ): Promise<PageResult<Repository>> {
    const org = validateLogin(value)
    const query = validateRepositorySearch(queryValue)
    const page = validatePage(pageValue)
    const search = encodeURIComponent(`${query} in:name org:${org}`)
    const { data, hasNext } = await this.requestWithMeta<{
      total_count?: number; items: RemoteRepository[]
    }>(`/search/repositories?q=${search}&per_page=20&page=${page}`)
    return {
      items: data.items.map(toRepository),
      hasNext: searchHasNext(hasNext, data.total_count, page, 20),
      totalCount: data.total_count
    }
  }

  async searchRepositories(queryValue: string, pageValue: number): Promise<PageResult<Repository>> {
    const query = validateRepositorySearch(queryValue)
    const page = validatePage(pageValue)
    const search = encodeURIComponent(`${query} in:name`)
    const { data, hasNext } = await this.requestWithMeta<{
      total_count?: number; items: RemoteRepository[]
    }>(`/search/repositories?q=${search}&per_page=20&page=${page}`)
    return {
      items: data.items.map(toRepository),
      hasNext: searchHasNext(hasNext, data.total_count, page, 20),
      totalCount: data.total_count
    }
  }

  async repository(ownerValue: string, nameValue: string, signal?: AbortSignal): Promise<Repository> {
    const owner = validateLogin(ownerValue)
    const name = validateRepository(nameValue)
    return toRepository(await this.request<RemoteRepository>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, signal))
  }
  async releases(ownerValue: string, nameValue: string, signal?: AbortSignal): Promise<Release[]> {
    const owner = validateLogin(ownerValue)
    const name = validateRepository(nameValue)
    const result = await this.request<Array<{
      id: number; tag_name: string; name: string | null; draft: boolean;
      prerelease: boolean; published_at: string | null; html_url: string
    }>>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/releases?per_page=25`, signal)
    return result.map((r) => ({ id: r.id, tagName: r.tag_name, name: r.name,
      draft: r.draft, prerelease: r.prerelease, publishedAt: r.published_at, htmlUrl: r.html_url }))
  }
  async workflowRuns(ownerValue: string, nameValue: string, signal?: AbortSignal): Promise<WorkflowRun[]> {
    const owner = validateLogin(ownerValue)
    const name = validateRepository(nameValue)
    const result = await this.request<{ workflow_runs: Array<{
      id: number; name: string; event: string; status: string; conclusion: string | null;
      head_branch: string; created_at: string; html_url: string
    }> }>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/actions/runs?per_page=25`, signal)
    return result.workflow_runs.map((r) => ({ id: r.id, name: r.name, event: r.event,
      status: r.status, conclusion: r.conclusion, headBranch: r.head_branch,
      createdAt: r.created_at, htmlUrl: r.html_url }))
  }
}
type RemoteRepository = {
  id: number; full_name: string; name: string; description: string | null;
  private: boolean; archived: boolean; default_branch: string;
  updated_at: string; html_url: string
}
function toRepository(r: RemoteRepository): Repository {
  return { id: r.id, fullName: r.full_name, name: r.name, description: r.description,
    private: r.private, archived: r.archived, defaultBranch: r.default_branch,
    updatedAt: r.updated_at, htmlUrl: r.html_url }
}

/** GitHub Search results cap navigation at 1,000 entries. */
function searchHasNext(linkHasNext: boolean, count: number | undefined, page: number, size: number): boolean {
  if (page * size >= 1000) return false
  if (linkHasNext) return true
  return typeof count === 'number' && Number.isSafeInteger(count) &&
    page * size < Math.min(count, 1000)
}
