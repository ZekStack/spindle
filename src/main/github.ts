import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { managedGitHubToken } from './managed-token'
import {
  LOGIN_PATTERN, validateLogin, validatePage, validateRepository,
  type AuthStatus, type GitHubIdentity, type Organization, type Release, type Repository, type WorkflowRun
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
  private async request<T>(path: string): Promise<T> {
    const creds = await this.credentials.get()
    const response = await this.requestFn(BASE + path, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'Spindle-Desktop',
        ...(creds.token ? { Authorization: `Bearer ${creds.token}` } : {})
      },
      signal: AbortSignal.timeout(12_000)
    })
    if (!response.ok) {
      if (response.status === 404) throw new Error(
        'Not found or inaccessible on GitHub. Check the name and your GitHub credentials.')
      if (response.status === 401) throw new Error('GitHub authentication failed. Sign in using gh auth login.')
      if (response.status === 403) throw new Error('GitHub access denied or rate limited. Check permissions and API limits.')
      throw new Error(`GitHub request failed (HTTP ${response.status})`)
    }
    return response.json() as Promise<T>
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
  async repositories(value: string, pageValue: number): Promise<Repository[]> {
    const org = validateLogin(value)
    const page = validatePage(pageValue)
    const result = await this.request<Array<{
      id: number; full_name: string; name: string; description: string | null;
      private: boolean; archived: boolean; default_branch: string;
      updated_at: string; html_url: string
    }>>(`/orgs/${encodeURIComponent(org)}/repos?per_page=100&page=${page}&sort=full_name&direction=asc&type=all`)
    return result.map(toRepository)
  }
  async repository(ownerValue: string, nameValue: string): Promise<Repository> {
    const owner = validateLogin(ownerValue)
    const name = validateRepository(nameValue)
    return toRepository(await this.request<RemoteRepository>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`))
  }
  async releases(ownerValue: string, nameValue: string): Promise<Release[]> {
    const owner = validateLogin(ownerValue)
    const name = validateRepository(nameValue)
    const result = await this.request<Array<{
      id: number; tag_name: string; name: string | null; draft: boolean;
      prerelease: boolean; published_at: string | null; html_url: string
    }>>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/releases?per_page=25`)
    return result.map((r) => ({ id: r.id, tagName: r.tag_name, name: r.name,
      draft: r.draft, prerelease: r.prerelease, publishedAt: r.published_at, htmlUrl: r.html_url }))
  }
  async workflowRuns(ownerValue: string, nameValue: string): Promise<WorkflowRun[]> {
    const owner = validateLogin(ownerValue)
    const name = validateRepository(nameValue)
    const result = await this.request<{ workflow_runs: Array<{
      id: number; name: string; event: string; status: string; conclusion: string | null;
      head_branch: string; created_at: string; html_url: string
    }> }>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/actions/runs?per_page=25`)
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
