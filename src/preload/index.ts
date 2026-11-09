import { contextBridge, ipcRenderer } from 'electron'
import type { SpindleApi } from '../shared/contracts'
import type { UpdateStatus } from '../shared/update-policy'
import type { JobRecord } from '../shared/jobs'

// Deliberately expose only fixed operations with typed arguments.
const api: SpindleApi = {
  listJobs: () => ipcRenderer.invoke('spindle:jobs:list'),
  inspectRepository: (owner, name) => ipcRenderer.invoke('spindle:jobs:inspect', owner, name),
  pickLocalGitFolder: () => ipcRenderer.invoke('spindle:jobs:local-pick'),
  retryLocalGitJob: (id) => ipcRenderer.invoke('spindle:jobs:local-retry', id),
  cancelJob: (id) => ipcRenderer.invoke('spindle:jobs:cancel', id),
  onJobsChanged: (listener: (jobs: JobRecord[]) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, items: JobRecord[]) => listener(items)
    ipcRenderer.on('spindle:jobs:changed', handler)
    return () => ipcRenderer.removeListener('spindle:jobs:changed', handler)
  },
  getWorkspace: () => ipcRenderer.invoke('spindle:workspace:get'),
  getLocalWorkspaces: () => ipcRenderer.invoke('spindle:local:get'),
  pickWorkspaceRoot: () => ipcRenderer.invoke('spindle:local:pick-root'),
  removeWorkspaceRoot: (path) => ipcRenderer.invoke('spindle:local:remove-root', path),
  linkRepositoryFolder: (owner, name) => ipcRenderer.invoke('spindle:local:link', owner, name),
  unlinkRepositoryFolder: (owner, name) => ipcRenderer.invoke('spindle:local:unlink', owner, name),
  inspectLinkedRepository: (owner, name) => ipcRenderer.invoke('spindle:local:inspect', owner, name),
  cloneRepository: (owner, name, root) => ipcRenderer.invoke('spindle:local:clone', owner, name, root),
  syncLinkedRepository: (owner, name, operation) =>
    ipcRenderer.invoke('spindle:local:sync', owner, name, operation),
  previewLinkedPull: (owner, name) => ipcRenderer.invoke('spindle:local:pull-preview', owner, name),
  listLinkedTags: (owner, name) => ipcRenderer.invoke('spindle:local:tags', owner, name),
  mutateLinkedTag: (owner, name, request) =>
    ipcRenderer.invoke('spindle:local:tag-action', owner, name, request),
  addOrganization: (login) => ipcRenderer.invoke('spindle:workspace:add-org', login),
  removeOrganization: (login) => ipcRenderer.invoke('spindle:workspace:remove-org', login),
  trackRepository: (owner, name, tracked) =>
    ipcRenderer.invoke('spindle:workspace:track-repo', owner, name, tracked),
  getOrganization: (login) => ipcRenderer.invoke('spindle:github:organization', login),
  searchOrganizations: (query, page) => ipcRenderer.invoke('spindle:github:search-orgs', query, page),
  listAccessibleOrganizations: (page) => ipcRenderer.invoke('spindle:github:my-orgs', page),
  listRepositories: (login, page) => ipcRenderer.invoke('spindle:github:repositories', login, page),
  searchOrganizationRepositories: (login, query, page) =>
    ipcRenderer.invoke('spindle:github:org-repo-search', login, query, page),
  searchRepositories: (query, page) => ipcRenderer.invoke('spindle:github:search-repos', query, page),
  getRepository: (owner, name) => ipcRenderer.invoke('spindle:github:repository', owner, name),
  listReleases: (owner, name) => ipcRenderer.invoke('spindle:github:releases', owner, name),
  getReleaseProgress: (jobId) => ipcRenderer.invoke('spindle:github:release-progress', jobId),
  previewReleaseTag: (owner, name, tag) =>
    ipcRenderer.invoke('spindle:github:release-tag', owner, name, tag),
  getReleaseDetails: (owner, name, id) =>
    ipcRenderer.invoke('spindle:github:release-detail', owner, name, id),
  mutateRelease: (owner, name, request) =>
    ipcRenderer.invoke('spindle:github:release-action', owner, name, request),
  pickReleaseAsset: (owner, name, request) =>
    ipcRenderer.invoke('spindle:github:release-pick-asset', owner, name, request),
  getReleaseStrategy: (owner, name) => ipcRenderer.invoke('spindle:strategy:get', owner, name),
  saveReleaseStrategy: (owner, name, strategy) =>
    ipcRenderer.invoke('spindle:strategy:save', owner, name, strategy),
  listReleaseWorkflows: (owner, name) =>
    ipcRenderer.invoke('spindle:strategy:workflows', owner, name),
  pushReleaseTag: (owner, name, tag, oid) =>
    ipcRenderer.invoke('spindle:strategy:push-tag', owner, name, tag, oid),
  dispatchReleaseWorkflow: (owner, name, request) =>
    ipcRenderer.invoke('spindle:strategy:dispatch', owner, name, request),
  listWorkflowRuns: (owner, name) => ipcRenderer.invoke('spindle:github:runs', owner, name),
  listWorkflowCatalog: (owner, name, page) =>
    ipcRenderer.invoke('spindle:workflows:catalog', owner, name, page),
  getWorkflowSource: (owner, name, workflowId) =>
    ipcRenderer.invoke('spindle:workflows:source', owner, name, workflowId),
  previewWorkflowDispatch: (owner, name, workflowId, ref, refType) =>
    ipcRenderer.invoke('spindle:workflows:dispatch-preview', owner, name, workflowId, ref, refType),
  controlWorkflow: (owner, name, request) =>
    ipcRenderer.invoke('spindle:workflows:control', owner, name, request),
  listWorkflowRunPage: (owner, name, workflowId, filter) =>
    ipcRenderer.invoke('spindle:workflows:runs', owner, name, workflowId, filter),
  getAuthStatus: () => ipcRenderer.invoke('spindle:auth:status'),
  getGitHubIdentity: (refresh = false) => ipcRenderer.invoke('spindle:auth:identity', refresh),
  getDeviceAuthSetup: () => ipcRenderer.invoke('spindle:auth:device-setup'),
  startDeviceAuth: (clientId) => ipcRenderer.invoke('spindle:auth:device-start', clientId),
  pollDeviceAuth: () => ipcRenderer.invoke('spindle:auth:device-poll'),
  cancelDeviceAuth: () => ipcRenderer.invoke('spindle:auth:device-cancel'),
  listManagedGitHubAccounts: () => ipcRenderer.invoke('spindle:auth:accounts'),
  selectManagedGitHubAccount: (login) => ipcRenderer.invoke('spindle:auth:select-account', login),
  removeManagedGitHubAccount: (login) => ipcRenderer.invoke('spindle:auth:remove-account', login),
  signOutManagedGitHub: () => ipcRenderer.invoke('spindle:auth:managed-signout'),
  openGitHub: (url) => ipcRenderer.invoke('spindle:github:open', url),
  getUpdateStatus: () => ipcRenderer.invoke('spindle:update:state'),
  getUpdatePreferences: () => ipcRenderer.invoke('spindle:update:preferences'),
  setUpdatePreferences: (value) => ipcRenderer.invoke('spindle:update:set-preferences', value),
  checkForUpdates: () => ipcRenderer.invoke('spindle:update:check'),
  downloadUpdate: () => ipcRenderer.invoke('spindle:update:download'),
  installUpdate: () => ipcRenderer.invoke('spindle:update:install'),
  copyUpdateDiagnostics: () => ipcRenderer.invoke('spindle:update:copy-diagnostics'),
  onUpdateStatus: (listener: (state: UpdateStatus) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: UpdateStatus) => listener(state)
    ipcRenderer.on('spindle:update:status', handler)
    return () => ipcRenderer.removeListener('spindle:update:status', handler)
  }
}
contextBridge.exposeInMainWorld('spindle', api)
