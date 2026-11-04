import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GitHubClient } from './github'
import { WorkspaceStore } from './store'
import { UpdateManager } from './updater'
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
    const watchdog = setTimeout(() => {
      console.error('Spindle smoke test timed out')
      app.exit(1)
    }, 20_000)
    mainWindow.webContents.once('did-finish-load', async () => {
      try {
        // Verifies that the sandboxed preload works and IPC reaches main.
        const result = await mainWindow.webContents.executeJavaScript(
          "(async () => { const api = window.spindle; if (!api || typeof api.getWorkspace !== 'function') return false; const state = await api.getWorkspace(); return Array.isArray(state.organizations) && Array.isArray(state.trackedRepositories); })()"
        )
        if (!result) throw new Error('Preload or workspace bridge unavailable')
        clearTimeout(watchdog)
        console.log('Spindle Electron preload and IPC smoke test passed')
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
