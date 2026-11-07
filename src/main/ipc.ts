import { clipboard, dialog, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { GitHubClient } from './github'
import { githubDeviceAuth } from './device-auth'
import { managedGitHubToken } from './managed-token'
import { WorkspaceStore } from './store'
import { LocalWorkspaceStore } from './local-workspaces'
import { ReleaseStrategyStore } from './release-strategies'
import { JobManager } from './jobs'
import type { TagMutationRequest } from '../shared/tags'
import type { ReleaseMutationRequest } from '../shared/releases'
import {
  validateReleaseStrategy, validateWorkflowId, type ReleaseStrategy,
  type WorkflowDispatchRequest
} from '../shared/release-strategies'
import { UpdateManager } from './updater'
import { parseGitHubUrl, validateLogin, validateRepository } from '../shared/contracts'

export function registerIpc(window: BrowserWindow, store: WorkspaceStore, github: GitHubClient, updates: UpdateManager, jobs: JobManager, local: LocalWorkspaceStore, releaseStrategies: ReleaseStrategyStore): void {
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
    jobs.inspectLinked(owner, name))
  handle('spindle:local:clone', (owner: string, name: string, root: string) =>
    jobs.clone(owner, name, root))
  handle('spindle:local:sync', (owner: string, name: string, operation: 'fetch' | 'pull') =>
    jobs.sync(owner, name, operation))
  handle('spindle:local:pull-preview', (owner: string, name: string) =>
    jobs.previewPull(owner, name))
  handle('spindle:local:tags', (owner: string, name: string) => jobs.tags(owner, name))
  handle('spindle:local:tag-action', (owner: string, name: string, request: TagMutationRequest) =>
    jobs.mutateTag(owner, name, request))
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
  handle('spindle:github:release-progress', (jobId: string) => jobs.releaseProgress(jobId))
  handle('spindle:github:release-tag', (owner: string, name: string, tag: string) =>
    github.releaseTag(owner, name, tag))
  handle('spindle:github:release-detail', (owner: string, name: string, id: number) =>
    github.releaseDetails(owner, name, id))
  handle('spindle:github:release-action', (owner: string, name: string, request: ReleaseMutationRequest) =>
    jobs.mutateRelease(owner, name, request))
  handle('spindle:github:release-pick-asset', async (owner: string, name: string,
    request: ReleaseMutationRequest) => {
    // File bytes and paths never cross the renderer boundary.
    if (request?.action !== 'upload-asset') throw new Error('Invalid asset action')
    const selected = await dialog.showOpenDialog(window, {
      title: 'Select release asset', properties: ['openFile']
    })
    return selected.canceled || selected.filePaths.length !== 1
      ? null : jobs.mutateRelease(owner, name, request, selected.filePaths[0])
  })
  handle('spindle:strategy:get', (owner: string, name: string) =>
    releaseStrategies.get(`${validateLogin(owner)}/${validateRepository(name)}`))
  handle('spindle:strategy:save', async (owner: string, name: string, input: ReleaseStrategy) => {
    const repository = `${validateLogin(owner)}/${validateRepository(name)}`
    const strategy = validateReleaseStrategy(input)
    if (strategy.kind !== 'api') {
      await github.releaseWorkflow(owner, name, strategy.workflowId)
    }
    return releaseStrategies.save(repository, strategy)
  })
  handle('spindle:strategy:workflows', (owner: string, name: string) =>
    github.workflows(owner, name))
  handle('spindle:strategy:push-tag', async (owner: string, name: string, tag: string, oid: string) => {
    const strategy = releaseStrategies.get(`${validateLogin(owner)}/${validateRepository(name)}`)
    if (strategy.kind !== 'tag-push') throw new Error('Release strategy changed; refresh first')
    await github.releaseWorkflow(owner, name, validateWorkflowId(strategy.workflowId))
    return jobs.mutateTag(owner, name, { action: 'push', tag, expectedLocalOid: oid },
      strategy.workflowId)
  })
  handle('spindle:strategy:dispatch', (owner: string, name: string, request: WorkflowDispatchRequest) =>
    jobs.dispatchRelease(owner, name, request))
  handle('spindle:github:runs', (owner: string, name: string) => github.workflowRuns(owner, name))
  handle('spindle:workflows:catalog', (owner: string, name: string, page: number) =>
    github.workflowCatalog(owner, name, page))
  handle('spindle:workflows:source', (owner: string, name: string, workflowId: number) =>
    github.workflowSource(owner, name, workflowId))
  handle('spindle:workflows:runs', (owner: string, name: string, workflowId: number,
    filter: import('../shared/workflow-discovery').WorkflowRunsFilter) =>
    github.workflowRunPage(owner, name, workflowId, filter))
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
