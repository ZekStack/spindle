import { contextBridge, ipcRenderer } from 'electron'
import type { SpindleApi } from '../shared/contracts'

// Deliberately expose only fixed operations with typed arguments.
const api: SpindleApi = {
  getWorkspace: () => ipcRenderer.invoke('spindle:workspace:get'),
  addOrganization: (login) => ipcRenderer.invoke('spindle:workspace:add-org', login),
  removeOrganization: (login) => ipcRenderer.invoke('spindle:workspace:remove-org', login),
  trackRepository: (owner, name, tracked) =>
    ipcRenderer.invoke('spindle:workspace:track-repo', owner, name, tracked),
  getOrganization: (login) => ipcRenderer.invoke('spindle:github:organization', login),
  listRepositories: (login, page) => ipcRenderer.invoke('spindle:github:repositories', login, page),
  getRepository: (owner, name) => ipcRenderer.invoke('spindle:github:repository', owner, name),
  listReleases: (owner, name) => ipcRenderer.invoke('spindle:github:releases', owner, name),
  listWorkflowRuns: (owner, name) => ipcRenderer.invoke('spindle:github:runs', owner, name),
  getAuthStatus: () => ipcRenderer.invoke('spindle:auth:status'),
  openGitHub: (url) => ipcRenderer.invoke('spindle:github:open', url)
}
contextBridge.exposeInMainWorld('spindle', api)
