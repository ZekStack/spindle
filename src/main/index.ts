import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GitHubClient } from './github'
import { WorkspaceStore } from './store'
import { UpdateManager } from './updater'
import { verifyRunningDebPackage } from './deb-preflight'
import { registerIpc } from './ipc'
import { parseGitHubUrl } from '../shared/contracts'

const ROOT = fileURLToPath(new URL('.', import.meta.url))
let window: BrowserWindow | null = null
let updater: UpdateManager | null = null

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 850,
    minHeight: 580,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#101113',
    webPreferences: {
      preload: join(ROOT, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true
    }
  })
  window = mainWindow
  updater ??= new UpdateManager()
  registerIpc(mainWindow,
    new WorkspaceStore(join(app.getPath('userData'), 'workspace.json')),
    new GitHubClient(), updater)
  mainWindow.once('ready-to-show', () => mainWindow.show())
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try { void shell.openExternal(parseGitHubUrl(url)) } catch { /* Reject external URLs */ }
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowedOrigin = process.env.ELECTRON_RENDERER_URL
    const valid = allowedOrigin
      ? new URL(url).origin === new URL(allowedOrigin).origin
      : url.startsWith('file:') && fileURLToPath(url) === join(ROOT, '../renderer/index.html')
    if (!valid) event.preventDefault()
  })
  if (process.env.SPINDLE_SMOKE_TEST === '1') {
    const installedDebSmoke = process.env.SPINDLE_SMOKE_INSTALLED_DEB === '1'
    const watchdog = setTimeout(() => {
      console.error('Spindle smoke test timed out')
      app.exit(1)
    }, 20_000)
    mainWindow.webContents.once('did-finish-load', async () => {
      try {
        // Verifies that the sandboxed preload works and IPC reaches main.
        // Test the renderer-to-main bridge for both the development runtime
        // and the real, system-installed Debian package. The packaged case
        // also exercises the updater's actual package-type marker.
        const result: {
          workspace: boolean; phase: string; installType: string; version: string
        } | null = await mainWindow.webContents.executeJavaScript(
          "(async () => { const api = window.spindle; if (!api || typeof api.getWorkspace !== 'function') return null; const state = await api.getWorkspace(); const update = await api.getUpdateStatus(); return { workspace: Array.isArray(state.organizations) && Array.isArray(state.trackedRepositories), phase: update.phase, installType: update.installType, version: update.currentVersion }; })()"
        )
        const expectedPhase = installedDebSmoke ? 'idle' : 'disabled'
        const expectedInstaller = installedDebSmoke ? 'deb' : 'unknown'
        if (!result?.workspace || result.phase !== expectedPhase ||
            result.installType !== expectedInstaller || result.version !== app.getVersion()) {
          throw new Error('Preload, IPC or package detection smoke test failed')
        }
        if (installedDebSmoke) {
          if (!app.isPackaged || process.platform !== 'linux') {
            throw new Error('Installed DEB smoke must run in a packaged Linux executable')
          }
          // Validates actual dpkg ownership AND Debian-versus-Electron
          // version equality, not a fake package-manager test runner.
          await verifyRunningDebPackage(process.execPath, app.getVersion())
        }
        clearTimeout(watchdog)
        console.log(installedDebSmoke
          ? 'Spindle installed Debian package ownership, updater and IPC smoke passed'
          : 'Spindle Electron preload and IPC smoke test passed')
        app.exit(0)
      } catch (error) {
        clearTimeout(watchdog)
        console.error('Spindle smoke failed:', error)
        app.exit(1)
      }
    })
  }
  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(ROOT, '../renderer/index.html'))
  }
  // The user sees the update offer only after the renderer has mounted.
  // The service never checks for updates in development or smoke-test mode.
  if (process.env.SPINDLE_SMOKE_TEST !== '1') {
    mainWindow.webContents.once('did-finish-load', () => {
      if (updater) void updater.check()
    })
  }
  mainWindow.on('closed', () => { window = null })
}

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow() })
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
