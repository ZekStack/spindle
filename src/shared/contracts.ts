// The renderer knows only these data shapes and the methods exposed by preload.
// No filesystem, Node, shell, credentials, or general-purpose IPC access.
export interface Workspace {
  organizations: string[]
  trackedRepositories: string[]
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
  method: 'github-cli' | 'environment' | 'anonymous'
}
export interface SpindleApi {
  getWorkspace(): Promise<Workspace>
  addOrganization(login: string): Promise<Workspace>
  removeOrganization(login: string): Promise<Workspace>
  trackRepository(owner: string, name: string, tracked: boolean): Promise<Workspace>
  getOrganization(login: string): Promise<Organization>
  listRepositories(login: string, page: number): Promise<Repository[]>
  getRepository(owner: string, name: string): Promise<Repository>
  listReleases(owner: string, name: string): Promise<Release[]>
  listWorkflowRuns(owner: string, name: string): Promise<WorkflowRun[]>
  getAuthStatus(): Promise<AuthStatus>
  openGitHub(url: string): Promise<void>
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
