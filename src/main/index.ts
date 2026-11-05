import { app, BrowserWindow, shell } from 'electron'
import { realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GitHubClient } from './github'
import { WorkspaceStore } from './store'
import { JobManager } from './jobs'
import { UpdateManager } from './updater'
import { verifyRunningDebPackage } from './deb-preflight'
import { registerIpc } from './ipc'
import { parseGitHubUrl } from '../shared/contracts'
import { isEligibleUpdate } from '../shared/update-policy'

const ROOT = fileURLToPath(new URL('.', import.meta.url))
let window: BrowserWindow | null = null
let updater: UpdateManager | null = null
let jobs: JobManager | null = null

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
  const github = new GitHubClient()
  jobs ??= new JobManager(join(app.getPath('userData'), 'activity-history.json'), github)
  registerIpc(mainWindow,
    new WorkspaceStore(join(app.getPath('userData'), 'workspace.json')),
    github, updater, jobs)
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
    const installedNsisSmoke = process.env.SPINDLE_SMOKE_INSTALLED_NSIS === '1'
    const appImageSmoke = process.env.SPINDLE_SMOKE_APPIMAGE === '1'
    const liveDebSmoke = process.env.SPINDLE_SMOKE_LIVE_DEB_UPDATE === '1'
    const watchdog = setTimeout(() => {
      console.error('Spindle smoke test timed out')
      app.exit(1)
    }, liveDebSmoke ? 300_000 : 20_000)
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
        if (Number(installedDebSmoke) + Number(installedNsisSmoke) + Number(appImageSmoke) > 1) {
          throw new Error('Conflicting native smoke modes')
        }
        const expectedPhase = installedDebSmoke || installedNsisSmoke || appImageSmoke ? 'idle' : 'disabled'
        const expectedInstaller = installedDebSmoke ? 'deb'
          : installedNsisSmoke ? 'nsis' : appImageSmoke ? 'appimage' : 'unknown'
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
        if (installedNsisSmoke && (!app.isPackaged || process.platform !== 'win32')) {
          throw new Error('Installed NSIS smoke must run in a packaged Windows executable')
        }
        if (appImageSmoke) {
          if (!app.isPackaged || process.platform !== 'linux') {
            throw new Error('AppImage smoke must run as a packaged Linux application')
          }
          const expectedImage = process.env.SPINDLE_SMOKE_EXPECTED_APPIMAGE
          if (!expectedImage || !process.env.APPIMAGE ||
              realpathSync(process.env.APPIMAGE) !== realpathSync(expectedImage)) {
            throw new Error('Running AppImage identity does not match the expected portable executable')
          }
        }
        // Opt-in only: use the *actual* packaged updater and GitHub feed, not
        // fake update events. Run from an installed older DEB on an ephemeral
        // CI runner and stop at download verification; never elevate/install.
        let liveDownload: { version: string; phase: string; percent: number | null } | null = null
        if (liveDebSmoke) {
          if (!installedDebSmoke || !updater || !app.isPackaged || process.platform !== 'linux') {
            throw new Error('Live updater smoke requires an installed Linux DEB')
          }
          const checked: { phase: string; availableVersion: string | null } =
            await mainWindow.webContents.executeJavaScript('window.spindle.checkForUpdates()')
          const target = checked.availableVersion
          if (checked.phase !== 'available' || !target ||
              !isEligibleUpdate(app.getVersion(), target)) {
            throw new Error('Live GitHub feed did not offer a newer eligible release')
          }
          const downloaded: {
            phase: string; availableVersion: string | null; percent: number | null
          } = await mainWindow.webContents.executeJavaScript('window.spindle.downloadUpdate()')
          if (downloaded.phase !== 'ready' || downloaded.availableVersion !== target ||
              downloaded.percent !== 100) {
            throw new Error('Real Debian GitHub download did not finish with a verified DEB')
          }
          liveDownload = { version: target, phase: downloaded.phase, percent: downloaded.percent }
        }
        // A Windows GUI executable may not have an attached stdout stream.
        // CI requires this proof, written only after all assertions succeed.
        const proof = process.env.SPINDLE_SMOKE_RESULT_FILE
        if (proof) {
          writeFileSync(proof, JSON.stringify({
            version: result.version, installType: result.installType, phase: result.phase,
            ...(liveDownload ? { liveDownload } : {})
          }), { flag: 'wx', mode: 0o600 })
        }
        clearTimeout(watchdog)
        console.log(liveDebSmoke
          ? `Spindle live GitHub Debian download passed: ${result.version} -> ${liveDownload?.version}`
          : installedDebSmoke
            ? 'Spindle installed Debian package ownership, updater and IPC smoke passed'
          : installedNsisSmoke
            ? 'Spindle installed Windows NSIS updater and IPC smoke passed'
            : appImageSmoke
              ? 'Spindle AppImage runtime, updater identity and IPC smoke passed'
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
