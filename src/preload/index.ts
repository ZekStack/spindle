import { contextBridge, ipcRenderer } from 'electron'
import type { SpindleApi } from '../shared/contracts'
import type { UpdateStatus } from '../shared/update-policy'

// Deliberately expose only fixed operations with typed arguments.
const api: SpindleApi = {
  getWorkspace: () => ipcRenderer.invoke('spindle:workspace:get'),
  addOrganization: (login) => ipcRenderer.invoke('spindle:workspace:add-org', login),
  removeOrganization: (login) => ipcRenderer.invoke('spindle:workspace:remove-org', login),
  trackRepository: (owner, name, tracked) =>
    ipcRenderer.invoke('spindle:workspace:track-repo', owner, name, tracked),
  getOrganization: (login) => ipcRenderer.invoke('spindle:github:organization', login),
  searchOrganizations: (query, page) => ipcRenderer.invoke('spindle:github:search-orgs', query, page),
  listRepositories: (login, page) => ipcRenderer.invoke('spindle:github:repositories', login, page),
  searchRepositories: (query, page) => ipcRenderer.invoke('spindle:github:search-repos', query, page),
  getRepository: (owner, name) => ipcRenderer.invoke('spindle:github:repository', owner, name),
  listReleases: (owner, name) => ipcRenderer.invoke('spindle:github:releases', owner, name),
  listWorkflowRuns: (owner, name) => ipcRenderer.invoke('spindle:github:runs', owner, name),
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
