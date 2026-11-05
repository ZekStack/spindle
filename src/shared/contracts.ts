// The renderer knows only these data shapes and the methods exposed by preload.
// No filesystem, Node, shell, credentials, or general-purpose IPC access.
import type { UpdateStatus } from './update-policy'
export interface Workspace {
  organizations: string[]
  trackedRepositories: string[]
}
/** GitHub pagination metadata, not inferred from a full final page. */
export interface PageResult<T> {
  items: T[]
  hasNext: boolean
  totalCount?: number
}
export interface OrganizationSuggestion {
  login: string
  avatarUrl: string | null
}
export interface Organization {
  login: string
  name: string | null
  avatarUrl: string
  description: string | null
  htmlUrl: string
  publicRepos: number
}
export interface Repository {
  id: number
  fullName: string
  name: string
  description: string | null
  private: boolean
  archived: boolean
  defaultBranch: string
  updatedAt: string
  htmlUrl: string
}
export interface Release {
  id: number
  tagName: string
  name: string | null
  draft: boolean
  prerelease: boolean
  publishedAt: string | null
  htmlUrl: string
}
export interface WorkflowRun {
  id: number
  name: string
  event: string
  status: string
  conclusion: string | null
  headBranch: string
  createdAt: string
  htmlUrl: string
}
export interface AuthStatus {
  method: 'spindle' | 'github-cli' | 'environment' | 'anonymous'
}

/** Safe account information: credentials and raw API responses stay in main. */
export interface GitHubIdentity {
  method: AuthStatus['method']
  state: 'authenticated' | 'anonymous' | 'invalid' | 'rate-limited' | 'forbidden' | 'unavailable'
  account: {
    login: string
    name: string | null
    avatarUrl: string | null
    htmlUrl: string
  } | null
  /** OAuth scopes, when reported by GitHub; null for unreported/fine-grained permissions. */
  scopes: string[] | null
}
/** Only validated GitHub logins and active selection cross the preload boundary. */
export interface ManagedAccountList {
  logins: string[]
  activeLogin: string | null
  legacyActive: boolean
}
/** Public device-flow details only: the secret device code never leaves main. */
export interface DeviceAuthSetup {
  secureStorage: boolean
  configuredClientId: string | null
}
export interface DeviceAuthStart {
  userCode: string
  verificationUrl: string
  expiresAt: number
  nextPollAt: number
}
export interface DeviceAuthProgress {
  phase: 'pending' | 'complete' | 'cancelled' | 'expired' | 'denied' | 'failed'
  nextPollAt: number | null
  networkError?: boolean
}

export interface SpindleApi {
  getWorkspace(): Promise<Workspace>
  addOrganization(login: string): Promise<Workspace>
  removeOrganization(login: string): Promise<Workspace>
  trackRepository(owner: string, name: string, tracked: boolean): Promise<Workspace>
  getOrganization(login: string): Promise<Organization>
  searchOrganizations(query: string, page: number): Promise<PageResult<OrganizationSuggestion>>
  listAccessibleOrganizations(page: number): Promise<PageResult<OrganizationSuggestion>>
  listRepositories(login: string, page: number): Promise<PageResult<Repository>>
  searchOrganizationRepositories(login: string, query: string, page: number): Promise<PageResult<Repository>>
  searchRepositories(query: string, page: number): Promise<PageResult<Repository>>
  getRepository(owner: string, name: string): Promise<Repository>
  listReleases(owner: string, name: string): Promise<Release[]>
  listWorkflowRuns(owner: string, name: string): Promise<WorkflowRun[]>
  getAuthStatus(): Promise<AuthStatus>
  getGitHubIdentity(refresh?: boolean): Promise<GitHubIdentity>
  getDeviceAuthSetup(): Promise<DeviceAuthSetup>
  startDeviceAuth(clientId?: string): Promise<DeviceAuthStart>
  pollDeviceAuth(): Promise<DeviceAuthProgress>
  cancelDeviceAuth(): Promise<void>
  listManagedGitHubAccounts(): Promise<ManagedAccountList>
  selectManagedGitHubAccount(login: string | null): Promise<ManagedAccountList>
  removeManagedGitHubAccount(login: string): Promise<ManagedAccountList>
  signOutManagedGitHub(): Promise<void>
  openGitHub(url: string): Promise<void>
  getUpdateStatus(): Promise<UpdateStatus>
  checkForUpdates(): Promise<UpdateStatus>
  downloadUpdate(): Promise<UpdateStatus>
  installUpdate(): Promise<UpdateStatus>
  copyUpdateDiagnostics(): Promise<void>
  onUpdateStatus(listener: (state: UpdateStatus) => void): () => void
}
export const LOGIN_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/
export const REPO_PATTERN = /^[a-zA-Z0-9_.-]{1,100}$/
export function validateLogin(value: unknown): string {
  if (typeof value !== 'string' || !LOGIN_PATTERN.test(value.trim())) {
    throw new Error('Invalid organization name')
  }
  return value.trim()
}
export function validateRepository(value: unknown): string {
  if (typeof value !== 'string' || !REPO_PATTERN.test(value.trim()) ||
      value === '.' || value === '..') throw new Error('Invalid repository name')
  return value.trim()
}
/** Treat search input only as repository-name text, never GitHub qualifiers. */
export function validateOrganizationSearch(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9-]{2,39}$/.test(value.trim())) {
    throw new Error('Enter at least two organization name characters')
  }
  return value.trim()
}

export function validateRepositorySearch(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_. -]{2,80}$/.test(value.trim())) {
    throw new Error('Enter a repository name (2–80 characters)')
  }
  return value.trim()
}

/** A direct owner/repository path, also valid for personal repositories. */
export function parseRepositoryFullName(value: unknown): { owner: string; name: string } {
  if (typeof value !== 'string') throw new Error('Expected owner/repository')
  const parts = value.trim().split('/')
  if (parts.length !== 2) throw new Error('Expected owner/repository')
  return { owner: validateLogin(parts[0]), name: validateRepository(parts[1]) }
}

export function validatePage(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 1000) {
    throw new Error('Invalid page number')
  }
  return value as number
}
export function parseGitHubUrl(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid GitHub URL')
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' ||
      url.username || url.password || url.port) throw new Error('Only GitHub HTTPS links are allowed')
  return url.href
}
