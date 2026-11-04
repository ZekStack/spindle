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
  listRepositories: (login, page) => ipcRenderer.invoke('spindle:github:repositories', login, page),
  getRepository: (owner, name) => ipcRenderer.invoke('spindle:github:repository', owner, name),
  listReleases: (owner, name) => ipcRenderer.invoke('spindle:github:releases', owner, name),
  listWorkflowRuns: (owner, name) => ipcRenderer.invoke('spindle:github:runs', owner, name),
  getAuthStatus: () => ipcRenderer.invoke('spindle:auth:status'),
  openGitHub: (url) => ipcRenderer.invoke('spindle:github:open', url),
  getUpdateStatus: () => ipcRenderer.invoke('spindle:update:state'),
  checkForUpdates: () => ipcRenderer.invoke('spindle:update:check'),
  downloadUpdate: () => ipcRenderer.invoke('spindle:update:download'),
  installUpdate: () => ipcRenderer.invoke('spindle:update:install'),
  onUpdateStatus: (listener: (state: UpdateStatus) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: UpdateStatus) => listener(state)
    ipcRenderer.on('spindle:update:status', handler)
    return () => ipcRenderer.removeListener('spindle:update:status', handler)
  }
}
contextBridge.exposeInMainWorld('spindle', api)
