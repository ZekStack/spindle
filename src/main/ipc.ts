import { clipboard, dialog, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { GitHubClient } from './github'
import { githubDeviceAuth } from './device-auth'
import { managedGitHubToken } from './managed-token'
import { WorkspaceStore } from './store'
import { LocalWorkspaceStore } from './local-workspaces'
import { JobManager } from './jobs'
import { UpdateManager } from './updater'
import { parseGitHubUrl, validateLogin, validateRepository } from '../shared/contracts'

export function registerIpc(window: BrowserWindow, store: WorkspaceStore, github: GitHubClient, updates: UpdateManager, jobs: JobManager, local: LocalWorkspaceStore): void {
  function allow(event: IpcMainInvokeEvent): void {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
      throw new Error('Untrusted IPC sender')
    }
    const frameUrl = event.senderFrame?.url
    if (!frameUrl) throw new Error('Unknown IPC sender')
    const dev = process.env.ELECTRON_RENDERER_URL
    if (dev) {
      if (new URL(frameUrl).origin !== new URL(dev).origin) throw new Error('Untrusted IPC origin')
    } else {
      if (!frameUrl.startsWith('file:') ||
          resolve(fileURLToPath(frameUrl)) !== resolve(fileURLToPath(new URL('../renderer/index.html', import.meta.url)))) {
        throw new Error('Untrusted IPC origin')
      }
    }
  }
  const handle = <Args extends unknown[], Return>(
    channel: string, fn: (...args: Args) => Promise<Return> | Return
  ) => {
    // Recreating a macOS window must not register duplicate global handlers.
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, (event, ...args: Args) => {
      allow(event)
      return fn(...args)
    })
  }

  handle('spindle:jobs:list', () => jobs.list())
  handle('spindle:jobs:inspect', (owner: string, name: string) => jobs.inspect(owner, name))
  handle('spindle:jobs:cancel', (id: string) => jobs.cancel(id))
  handle('spindle:jobs:local-pick', async () => {
    // Renderer cannot submit arbitrary filesystem paths or Git arguments.
    const selected = await dialog.showOpenDialog(window, {
      title: 'Select a local Git checkout',
      properties: ['openDirectory']
    })
    if (selected.canceled || selected.filePaths.length !== 1) return null
    return jobs.inspectLocal(selected.filePaths[0])
  })
  handle('spindle:jobs:local-retry', (id: string) => jobs.retryLocal(id))
  const removeJobsListener = jobs.subscribe((items) => {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send('spindle:jobs:changed', items)
    }
  })
  window.once('closed', removeJobsListener)
  handle('spindle:local:get', () => local.load())
  handle('spindle:local:pick-root', async () => {
    const selected = await dialog.showOpenDialog(window, {
      title: 'Add workspace directory', properties: ['openDirectory']
    })
    return selected.canceled || selected.filePaths.length !== 1
      ? null : local.addRootFromPicker(selected.filePaths[0])
  })
  handle('spindle:local:remove-root', (savedPath: string) => local.removeRoot(savedPath))
  handle('spindle:local:link', async (owner: string, name: string) => {
    const fullName = `${validateLogin(owner)}/${validateRepository(name)}`
    const selected = await dialog.showOpenDialog(window, {
      title: 'Link existing Git checkout', properties: ['openDirectory']
    })
    if (selected.canceled || selected.filePaths.length !== 1) return null
    return local.linkFromPicker(fullName, selected.filePaths[0])
  })
  handle('spindle:local:unlink', (owner: string, name: string) =>
    local.unlink(`${validateLogin(owner)}/${validateRepository(name)}`))
  handle('spindle:local:inspect', (owner: string, name: string) =>
    jobs.inspectLocal(local.pathFor(`${validateLogin(owner)}/${validateRepository(name)}`)))
  handle('spindle:workspace:get', () => store.load())
  handle('spindle:workspace:add-org', async (login: string) => {
    const org = await github.organization(validateLogin(login))
    return store.addOrganization(org.login)
  })
  handle('spindle:workspace:remove-org', (login: string) => store.removeOrganization(login))
  handle('spindle:workspace:track-repo', async (owner: string, name: string, tracked: boolean) => {
    const safeOwner = validateLogin(owner)
    const safeName = validateRepository(name)
    if (tracked === true) {
      // Store the verified canonical GitHub owner/name. No organization
      // registration is necessary, including for personal repositories.
      const repo = await github.repository(safeOwner, safeName)
      const parts = repo.fullName.split('/')
      return store.trackRepository(parts[0], parts[1], true)
    }
    return store.trackRepository(safeOwner, safeName, tracked)
  })
  handle('spindle:github:organization', (login: string) => github.organization(login))
  handle('spindle:github:search-orgs', (query: string, page: number) => github.searchOrganizations(query, page))
  handle('spindle:github:my-orgs', (page: number) => github.listAccessibleOrganizations(page))
  handle('spindle:github:repositories', (login: string, page: number) => github.repositories(login, page))
  handle('spindle:github:org-repo-search', (login: string, query: string, page: number) =>
    github.searchOrganizationRepositories(login, query, page))
  handle('spindle:github:search-repos', (query: string, page: number) => github.searchRepositories(query, page))
  handle('spindle:github:repository', (owner: string, name: string) => github.repository(owner, name))
  handle('spindle:github:releases', (owner: string, name: string) => github.releases(owner, name))
  handle('spindle:github:runs', (owner: string, name: string) => github.workflowRuns(owner, name))
  handle('spindle:auth:status', () => github.authStatus())
  handle('spindle:auth:identity', (refresh: boolean = false) => github.identity(refresh === true))
  handle('spindle:auth:device-setup', () => githubDeviceAuth.setup())
  handle('spindle:auth:device-start', (clientId?: string) => githubDeviceAuth.start(clientId))
  handle('spindle:auth:device-poll', () => githubDeviceAuth.poll())
  handle('spindle:auth:device-cancel', () => githubDeviceAuth.cancel())
  handle('spindle:auth:accounts', () => managedGitHubToken.accounts())
  handle('spindle:auth:select-account', async (login: string | null) => {
    githubDeviceAuth.cancel()
    return managedGitHubToken.select(login)
  })
  handle('spindle:auth:remove-account', async (login: string) => {
    githubDeviceAuth.cancel()
    return managedGitHubToken.remove(login)
  })
  handle('spindle:auth:managed-signout', () => githubDeviceAuth.signOut())
  handle('spindle:github:open', async (url: string) => { await shell.openExternal(parseGitHubUrl(url)) })
  handle('spindle:update:state', () => updates.snapshot())
  handle('spindle:update:check', () => updates.check(true))
  handle('spindle:update:download', () => updates.download())
  handle('spindle:update:install', () => updates.install())
  handle('spindle:update:copy-diagnostics', () => { clipboard.writeText(updates.diagnosticReport()) })
}
