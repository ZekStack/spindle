import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GitHubClient } from './github'
import { WorkspaceStore } from './store'
import { registerIpc } from './ipc'
import { parseGitHubUrl } from '../shared/contracts'

const ROOT = fileURLToPath(new URL('.', import.meta.url))
let window: BrowserWindow | null = null

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
  registerIpc(mainWindow,
    new WorkspaceStore(join(app.getPath('userData'), 'workspace.json')),
    new GitHubClient())
  mainWindow.once('ready-to-show', () => mainWindow.show())
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try { void shell.openExternal(parseGitHubUrl(url)) } catch { /* Reject external URLs */ }
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowedOrigin = process.env.ELECTRON_RENDERER_URL
    const valid = allowedOrigin
      ? new URL(url).origin === new URL(allowedOrigin).origin
      : url.startsWith('file:') && fileURLToPath(url).endsWith(join('renderer', 'index.html'))
    if (!valid) event.preventDefault()
  })
  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(ROOT, '../renderer/index.html'))
  }
  mainWindow.on('closed', () => { window = null })
}

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow() })
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
