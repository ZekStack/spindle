import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { decodeWorkflowContent, parseWorkflowDefinition } from './workflow-definition'
import {
  validateWorkflowPage, validateRunsFilter, type WorkflowCatalogPage,
  type WorkflowSource, type WorkflowRunsFilter, type WorkflowRunsPage
} from '../shared/workflow-discovery'
import { TAG_OID_PATTERN, validateTagName } from '../shared/tags'
import {
  validateWorkflowId, validateDispatchRequest, type WorkflowChoice,
  type WorkflowChoices, type WorkflowDispatchRequest
} from '../shared/release-strategies'
import {
  type ReleaseDetails, type ReleaseTagPreview, type ReleaseMutationRequest,
  validateReleaseMutation
} from '../shared/releases'
import {
  classifyReleaseProgress, correlateReleaseRuns, validateReleaseProgressTarget,
  type ReleaseProgressTarget, type ReleaseProgressSnapshot, type ReleaseRunEvidence,
  type ReleaseEvidence, type TagEvidence
} from '../shared/release-progress'
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

  /** A GitHub tag ref may point to a commit or to an annotated tag object. */
  async releaseTag(ownerValue: string, nameValue: string, tagValue: string,
    signal?: AbortSignal): Promise<ReleaseTagPreview> {
    const owner = validateLogin(ownerValue)
    const name = validateRepository(nameValue)
    const tag = validateTagName(tagValue)
    const prefix = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
    const raw = await this.request<{ object: { sha: string; type: string } }>(
      `${prefix}/git/ref/tags/${tag.split('/').map(encodeURIComponent).join('/')}`, signal)
    const oid = raw.object.sha
    if (!TAG_OID_PATTERN.test(oid)) throw new Error('GitHub returned an invalid tag object')
    let object = raw.object
    for (let depth = 0; depth < 8 && object.type === 'tag'; depth++) {
      const next = await this.request<{ object: { sha: string; type: string } }>(
        `${prefix}/git/tags/${object.sha}`, signal)
      object = next.object
    }
    if (object.type !== 'commit' || !TAG_OID_PATTERN.test(object.sha)) {
      throw new Error('Tag does not point to a verified commit')
    }
    return { name: tag, tagOid: oid, commitSha: object.sha }
  }

  async releaseDetails(ownerValue: string, nameValue: string, id: number,
    signal?: AbortSignal): Promise<ReleaseDetails> {
    const owner = validateLogin(ownerValue)
    const name = validateRepository(nameValue)
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid release ID')
    const raw = await this.request<{
      id: number; tag_name: string; name: string | null; body: string | null;
      draft: boolean; prerelease: boolean; immutable?: boolean;
      published_at: string | null; updated_at: string; html_url: string;
      assets: Array<{ id: number; name: string; size: number; state: string }>
    }>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/releases/${id}`, signal)
    const tagName = validateTagName(raw.tag_name)
    let ref: ReleaseTagPreview | null = null
    try {
      ref = await this.releaseTag(owner, name, tagName, signal)
    } catch (error) {
      // A deleted tag must not prevent deleting its independent GitHub Release.
      // Other failures remain explicit, never reclassified as an absent tag.
      if (!(error instanceof Error) || !error.message.includes('not found or inaccessible')) {
        throw error
      }
    }
    return {
      id: raw.id, tagName, name: raw.name, body: raw.body ?? '',
      draft: raw.draft, prerelease: raw.prerelease, immutable: raw.immutable === true,
      publishedAt: raw.published_at, updatedAt: raw.updated_at, htmlUrl: raw.html_url,
      assets: raw.assets.map(a => ({ id: a.id, name: a.name, size: a.size, state: a.state })),
      tagOid: ref?.tagOid ?? null, commitSha: ref?.commitSha ?? null
    }
  }

  /** Mutations use the active main-process identity and never expose the token over IPC. */
  private async releaseRequest(path: string, method: 'POST' | 'PATCH' | 'DELETE',
    body: Record<string, unknown> | Buffer | null, signal: AbortSignal): Promise<any> {
    const { token } = await this.credentials.get()
    if (!token) throw new Error('GitHub authentication is required for release mutations')
    let response: Response
    try {
      response = await this.requestFn(
        (Buffer.isBuffer(body) ? 'https://uploads.github.com' : BASE) + path,
        {
          method, signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
          headers: {
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'Spindle-Desktop',
            Authorization: `Bearer ${token}`,
            'Content-Type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json',
            ...(Buffer.isBuffer(body) ? { 'Content-Length': String(body.length) } : {})
          },
          ...(body === null ? {} : { body: Buffer.isBuffer(body) ? new Blob([new Uint8Array(body)]) : JSON.stringify(body) })
        }
      )
    } catch {
      throw new Error('GitHub connection failed. Refresh release status before retrying.')
    }
    if (response.status === 401) throw new Error('GitHub authentication expired or is invalid.')
    if (response.status === 403) throw new Error('GitHub denied this account access to releases.')
    if (response.status === 404) throw new Error('GitHub release not found or inaccessible.')
    if (response.status === 409 || response.status === 422) {
      throw new Error('GitHub rejected this release change. Refresh before retrying.')
    }
    if (response.status === 429) throw new Error('GitHub API rate limit reached.')
    if (!response.ok) throw new Error(`GitHub release operation failed (HTTP ${response.status}).`)
    if (response.status === 204) return null
    return response.json()
  }

  async mutateRelease(ownerValue: string, nameValue: string, input: ReleaseMutationRequest,
    signal: AbortSignal, pickedAssetPath?: string): Promise<void> {
    const owner = validateLogin(ownerValue)
    const name = validateRepository(nameValue)
    const request = validateReleaseMutation(input)
    const prefix = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
    if (request.action === 'create-draft') {
      const tag = await this.releaseTag(owner, name, request.tagName, signal)
      if (tag.tagOid !== request.expectedTagOid) throw new Error('Release tag changed since confirmation')
      await this.releaseRequest(`${prefix}/releases`, 'POST', {
        tag_name: tag.name, name: request.name, body: request.body,
        draft: true, prerelease: false, make_latest: 'false'
      }, signal)
      return
    }
    const details = await this.releaseDetails(owner, name, request.releaseId!, signal)
    if (details.tagName !== request.tagName ||
        details.tagOid !== request.expectedTagOid ||
        details.updatedAt !== request.expectedUpdatedAt) {
      throw new Error('Release changed since confirmation. Refresh before retrying.')
    }
    if (details.immutable) throw new Error('GitHub marks this release immutable.')
    const url = `${prefix}/releases/${request.releaseId}`
    switch (request.action) {
      case 'edit-notes':
        await this.releaseRequest(url, 'PATCH', { name: request.name, body: request.body }, signal)
        break
      case 'publish':
        if (!details.draft || !details.commitSha) {
          throw new Error('Only a draft with an existing verified tag can be published.')
        }
        await this.releaseRequest(url, 'PATCH', {
          draft: false, prerelease: request.prerelease, make_latest: 'false'
        }, signal)
        break
      case 'delete-release':
        await this.releaseRequest(url, 'DELETE', null, signal)
        break
      case 'upload-asset': {
        if (!pickedAssetPath) throw new Error('Select an asset using the native file picker')
        const fileName = basename(pickedAssetPath)
        if (!fileName || fileName === '.' || fileName.length > 150 ||
            /[\\/\x00-\x1f\x7f]/.test(fileName)) throw new Error('Invalid asset name')
        if (details.assets.some(a => a.name === fileName)) {
          throw new Error('An asset with that name already exists. No asset was overwritten.')
        }
        const info = await stat(pickedAssetPath)
        if (!info.isFile() || info.size < 1 || info.size > 32 * 1024 * 1024) {
          throw new Error('Asset must be a file between 1 byte and 32 MiB')
        }
        const buffer = await readFile(pickedAssetPath)
        if (buffer.length !== info.size || signal.aborted) {
          throw new Error('Asset changed or upload was cancelled.')
        }
        await this.releaseRequest(
          `${url}/assets?name=${encodeURIComponent(fileName)}`,
          'POST', buffer, signal)
        break
      }
    }
  }

  /** Server-paginated workflow list; filtering on the current page is renderer-local. */
  async workflowCatalog(ownerValue: string, nameValue: string, pageValue: number,
    signal?: AbortSignal): Promise<WorkflowCatalogPage> {
    const owner = validateLogin(ownerValue)
    const name = validateRepository(nameValue)
    const page = validateWorkflowPage(pageValue)
    const result = await this.requestWithMeta<{
      total_count: number
      workflows: Array<{ id: number; name: string; path: string; state: string }>
    }>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/actions/workflows?per_page=50&page=${page}`, signal)
    const items: WorkflowChoice[] = result.data.workflows
      .filter(entry => Number.isSafeInteger(entry.id) && entry.id > 0 &&
        typeof entry.path === 'string' &&
        /^\.github\/workflows\/[a-zA-Z0-9_.-]+\.ya?ml$/.test(entry.path))
      .map(entry => ({
        id: entry.id, name: typeof entry.name === 'string' ?
          entry.name.slice(0, 120) : entry.path,
        path: entry.path,
        state: typeof entry.state === 'string' ? entry.state.slice(0, 80) : 'unknown'
      }))
    const totalCount = Number.isSafeInteger(result.data.total_count) &&
      result.data.total_count >= 0 ? result.data.total_count : undefined
    return {
      items, page, pageSize: 50,
      hasNext: result.hasNext || (totalCount !== undefined && page * 50 < totalCount),
      ...(totalCount !== undefined ? { totalCount } : {})
    }
  }

  /** Inspect source in the repository's current default branch; do not guess workflow triggers. */
  async workflowSource(ownerValue: string, nameValue: string,
    rawId: number, signal?: AbortSignal): Promise<WorkflowSource> {
    const owner = validateLogin(ownerValue)
    const name = validateRepository(nameValue)
    const id = validateWorkflowId(rawId)
    const prefix = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
    const remote = await this.request<{
      id: number; name: string; path: string; state: string
    }>(`${prefix}/actions/workflows/${id}`, signal)
    if (remote.id !== id || typeof remote.path !== 'string' ||
      !/^\.github\/workflows\/[a-zA-Z0-9_.-]+\.ya?ml$/.test(remote.path)) {
      throw new Error('GitHub returned an invalid workflow definition')
    }
    const repo = await this.repository(owner, name, signal)
    const result: WorkflowSource = {
      workflow: { id, name: typeof remote.name === 'string' ?
        remote.name.slice(0, 120) : remote.path, path: remote.path,
        state: typeof remote.state === 'string' ? remote.state.slice(0, 80) : 'unknown' },
      branch: repo.defaultBranch, fileBlobSha: null,
      sourceState: 'unavailable', triggers: [], dispatchInputs: [],
      permissions: { mode: 'unspecified', entries: [] }, jobPermissions: []
    }
    try {
      const blob = await this.request<{
        type: string; path: string; sha: string;
        size: number; encoding: string; content: string
      }>(`${prefix}/contents/${remote.path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(repo.defaultBranch)}`, signal)
      if (blob.type !== 'file' || blob.path !== remote.path ||
        !TAG_OID_PATTERN.test(blob.sha)) throw new Error('Invalid workflow source')
      result.fileBlobSha = blob.sha
      if (blob.size > 128 * 1024) {
        result.sourceState = 'too-large'
        return result
      }
      const source = decodeWorkflowContent(blob)
      try {
        const parsed = parseWorkflowDefinition(source)
        return { ...result, ...parsed, sourceState: 'parsed' }
      } catch {
        // A syntactically invalid YAML file is not an absent workflow,
        // and should not expose parser internals or the source to the UI.
        result.sourceState = 'invalid'
        return result
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('not found or inaccessible')) {
        return result
      }
      if (error instanceof Error && /Workflow source|workflow source|Invalid workflow|Invalid UTF/i.test(error.message)) {
        result.sourceState = 'invalid'
        return result
      }
      // Network, invalid credentials and rate-limit are real read failures.
      throw error
    }
  }

  /** Filtered GitHub Actions runs for a single workflow with real API pagination. */
  async workflowRunPage(ownerValue: string, nameValue: string, rawId: number,
    input: WorkflowRunsFilter, signal?: AbortSignal): Promise<WorkflowRunsPage> {
    const owner = validateLogin(ownerValue)
    const name = validateRepository(nameValue)
    const workflowId = validateWorkflowId(rawId)
    const query = validateRunsFilter(input)
    const args = new URLSearchParams({ per_page: '30', page: String(query.page) })
    if (query.branch) args.set('branch', query.branch)
    if (query.event) args.set('event', query.event)
    if (query.status) args.set('status', query.status)
    const response = await this.requestWithMeta<{
      total_count: number
      workflow_runs: Array<{
        id: number; workflow_id: number; name: string | null;
        run_number: number; run_attempt: number;
        event: string; status: string; conclusion: string | null;
        head_branch: string | null; head_sha: string;
        created_at: string; updated_at: string; html_url: string
      }>
    }>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/actions/workflows/${workflowId}/runs?${args}`, signal)
    const items = response.data.workflow_runs
      .filter(run => Number.isSafeInteger(run.id) && run.id > 0 &&
        run.workflow_id === workflowId && TAG_OID_PATTERN.test(run.head_sha))
      .map(run => ({
        id: run.id, workflowId, name: (run.name ?? '').slice(0, 120),
        number: run.run_number, attempt: run.run_attempt,
        event: run.event, status: run.status,
        conclusion: run.conclusion, headBranch: run.head_branch,
        headSha: run.head_sha, createdAt: run.created_at,
        updatedAt: run.updated_at, htmlUrl: run.html_url
      }))
    const totalCount = Number.isSafeInteger(response.data.total_count) &&
      response.data.total_count >= 0 ? response.data.total_count : undefined
    return {
      items, page: query.page, workflowId,
      hasNext: response.hasNext || (totalCount !== undefined && query.page * 30 < totalCount),
      ...(totalCount !== undefined ? { totalCount } : {})
    }
  }

  /** Discover workflows from the selected repository, with no known-name catalog. */
  async workflows(ownerValue: string, nameValue: string, signal?: AbortSignal): Promise<WorkflowChoices> {
    const owner = validateLogin(ownerValue)
    const name = validateRepository(nameValue)
    const prefix = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
    const items: WorkflowChoice[] = []
    let truncated = false
    for (let page = 1; page <= 3; page++) {
      const response = await this.requestWithMeta<{
        workflows: Array<{ id: number; name: string; path: string; state: string }>
      }>(`${prefix}/actions/workflows?per_page=100&page=${page}`, signal)
      for (const item of response.data.workflows) {
        if (!Number.isSafeInteger(item.id) || item.id <= 0 ||
          typeof item.path !== 'string' ||
          !/^\.github\/workflows\/[a-zA-Z0-9_.-]+\.ya?ml$/.test(item.path)) continue
        items.push({
          id: item.id, name: typeof item.name === 'string' ? item.name.slice(0, 120) : item.path,
          path: item.path, state: typeof item.state === 'string' ? item.state : 'unknown'
        })
      }
      if (!response.hasNext) break
      if (page === 3) truncated = true
    }
    return { items, truncated }
  }

  /** A configured workflow must still belong to this repository and be active. */
  async releaseWorkflow(ownerValue: string, nameValue: string, rawId: number,
    signal?: AbortSignal): Promise<WorkflowChoice> {
    const owner = validateLogin(ownerValue)
    const name = validateRepository(nameValue)
    const id = validateWorkflowId(rawId)
    const item = await this.request<{
      id: number; name: string; path: string; state: string
    }>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/actions/workflows/${id}`, signal)
    if (item.id !== id || typeof item.path !== 'string' ||
        !/^\.github\/workflows\/[a-zA-Z0-9_.-]+\.ya?ml$/.test(item.path)) {
      throw new Error('Configured workflow no longer matches GitHub repository')
    }
    if (item.state !== 'active') throw new Error('Configured workflow is not active')
    return { id, path: item.path,
      name: typeof item.name === 'string' ? item.name.slice(0, 120) : item.path,
      state: 'active' }
  }

  /** Dispatch only a verified existing tag; GitHub accepts, not completes, the workflow. */
  async dispatchReleaseWorkflow(ownerValue: string, nameValue: string,
    input: WorkflowDispatchRequest, signal: AbortSignal): Promise<void> {
    const owner = validateLogin(ownerValue)
    const name = validateRepository(nameValue)
    const request = validateDispatchRequest(input)
    const tag = await this.releaseTag(owner, name, request.tagName, signal)
    if (tag.tagOid !== request.expectedTagOid) {
      throw new Error('Release tag changed since confirmation')
    }
    await this.releaseWorkflow(owner, name, request.workflowId, signal)
    await this.releaseRequest(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/actions/workflows/${request.workflowId}/dispatches`,
      'POST', { ref: request.ref, inputs: request.inputs }, signal)
  }

  /**
   * Read-only evidence gathering. A missing resource is not silently equated
   * with a failed workflow; every HTTP failure except expected 404 propagates.
   * A response never triggers a retry of a remote write.
   */
  async releaseProgress(ownerValue: string, nameValue: string,
    input: ReleaseProgressTarget, signal?: AbortSignal): Promise<ReleaseProgressSnapshot> {
    const owner = validateLogin(ownerValue)
    const name = validateRepository(nameValue)
    const target = validateReleaseProgressTarget(input)
    const prefix = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
    // Establish repository access before treating a ref/release 404 as absence.
    await this.repository(owner, name, signal)
    let tag: ReleaseTagPreview | null = null
    let tagState: TagEvidence = 'absent'
    try {
      tag = await this.releaseTag(owner, name, target.tagName, signal)
      tagState = target.expectedTagOid && tag.tagOid !== target.expectedTagOid
        ? 'changed' : 'matched'
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('not found or inaccessible')) {
        throw error
      }
    }

    type RawReleaseEvidence = {
      id: number; tag_name: string; draft: boolean; prerelease: boolean;
      html_url: string; assets: Array<{ name: string }>;
    }
    let release: RawReleaseEvidence | null = null
    let releaseState: ReleaseEvidence = 'absent'
    try {
      release = await this.request<RawReleaseEvidence>(
        `${prefix}/releases/tags/${encodeURIComponent(target.tagName)}`, signal)
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('not found or inaccessible')) {
        throw error
      }
      // Drafts may not resolve through the by-tag endpoint; list safely,
      // but do not assert absence if the bounded result is incomplete.
      const found = await this.requestWithMeta<Array<{
        id: number; tag_name: string; draft: boolean
      }>>(`${prefix}/releases?per_page=100`, signal)
      const candidate = found.data.find(value => value.tag_name === target.tagName)
      if (candidate) {
        const details = await this.releaseDetails(owner, name, candidate.id, signal)
        release = {
          id: details.id, tag_name: details.tagName, draft: details.draft,
          prerelease: details.prerelease, html_url: details.htmlUrl,
          assets: details.assets
        }
      } else if (found.hasNext) releaseState = 'unavailable'
    }
    if (release) {
      if (release.tag_name !== target.tagName || !Number.isSafeInteger(release.id) ||
        release.id <= 0 || !Array.isArray(release.assets)) {
        throw new Error('GitHub returned inconsistent release metadata')
      }
      releaseState = release.draft ? 'draft' : release.prerelease ? 'prerelease' : 'published'
    }
    const assets = release?.assets ?? []
    const runs: ReleaseRunEvidence[] = []
    let truncated = false
    if (target.workflowId !== null) {
      const event = target.kind === 'dispatch' ? 'workflow_dispatch' : 'push'
      type RawWorkflowRun = {
        id: number; workflow_id: number; event: string;
        status: string; conclusion: string | null;
        head_sha: string; head_branch: string | null;
        created_at: string; html_url: string;
      }
      for (let page = 1; page <= 2; page++) {
        const response: { data: { workflow_runs: RawWorkflowRun[] }; hasNext: boolean } =
          await this.requestWithMeta<{ workflow_runs: RawWorkflowRun[] }>(
          `${prefix}/actions/workflows/${target.workflowId}/runs?event=${event}&per_page=100&page=${page}`,
          signal)
        for (const run of response.data.workflow_runs as RawWorkflowRun[]) {
          if (!Number.isSafeInteger(run.id) || run.id <= 0 ||
            run.workflow_id !== target.workflowId ||
            typeof run.created_at !== 'string' || typeof run.head_sha !== 'string') continue
          runs.push({
            id: run.id, workflowId: run.workflow_id, event: run.event,
            status: run.status, conclusion: run.conclusion,
            headSha: run.head_sha, headBranch: run.head_branch,
            createdAt: run.created_at, htmlUrl: run.html_url
          })
        }
        if (!response.hasNext) break
        if (page === 2) truncated = true
      }
    }
    const run = correlateReleaseRuns(target, tag?.commitSha ?? null, runs, truncated)
    const result = classifyReleaseProgress(target, tagState, releaseState,
      run.correlation, run.matched)
    return {
      target, checkedAt: new Date().toISOString(),
      tag: { state: tagState, actualOid: tag?.tagOid ?? null,
        commitSha: tag?.commitSha ?? null },
      release: { state: releaseState, id: release?.id ?? null,
        htmlUrl: release?.html_url ?? null,
        assetCount: assets.length,
        assetNames: assets.slice(0, 30).map(asset => asset.name.slice(0, 150)) },
      run, ...result
    }
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
