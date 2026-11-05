import { clipboard, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { GitHubClient } from './github'
import { githubDeviceAuth } from './device-auth'
import { WorkspaceStore } from './store'
import { UpdateManager } from './updater'
import { parseGitHubUrl, validateLogin, validateRepository } from '../shared/contracts'

export function registerIpc(window: BrowserWindow, store: WorkspaceStore, github: GitHubClient, updates: UpdateManager): void {
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

  handle('spindle:workspace:get', () => store.load())
  handle('spindle:workspace:add-org', async (login: string) => {
    const org = await github.organization(validateLogin(login))
    return store.addOrganization(org.login)
  })
  handle('spindle:workspace:remove-org', (login: string) => store.removeOrganization(login))
  handle('spindle:workspace:track-repo', async (owner: string, name: string, tracked: boolean) => {
    if (tracked) await github.repository(validateLogin(owner), validateRepository(name))
    return store.trackRepository(owner, name, tracked)
  })
  handle('spindle:github:organization', (login: string) => github.organization(login))
  handle('spindle:github:repositories', (login: string, page: number) => github.repositories(login, page))
  handle('spindle:github:repository', (owner: string, name: string) => github.repository(owner, name))
  handle('spindle:github:releases', (owner: string, name: string) => github.releases(owner, name))
  handle('spindle:github:runs', (owner: string, name: string) => github.workflowRuns(owner, name))
  handle('spindle:auth:status', () => github.authStatus())
  handle('spindle:auth:identity', (refresh: boolean = false) => github.identity(refresh === true))
  handle('spindle:auth:device-setup', () => githubDeviceAuth.setup())
  handle('spindle:auth:device-start', (clientId?: string) => githubDeviceAuth.start(clientId))
  handle('spindle:auth:device-poll', () => githubDeviceAuth.poll())
  handle('spindle:auth:device-cancel', () => githubDeviceAuth.cancel())
  handle('spindle:auth:managed-signout', () => githubDeviceAuth.signOut())
  handle('spindle:github:open', async (url: string) => { await shell.openExternal(parseGitHubUrl(url)) })
  handle('spindle:update:state', () => updates.snapshot())
  handle('spindle:update:check', () => updates.check(true))
  handle('spindle:update:download', () => updates.download())
  handle('spindle:update:install', () => updates.install())
  handle('spindle:update:copy-diagnostics', () => { clipboard.writeText(updates.diagnosticReport()) })
}
