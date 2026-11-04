import { app, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import { GitHubCredentials } from './github'
import { isNewerRelease, isPrereleaseVersion, updateErrorMessage, type UpdateStatus } from '../shared/update-policy'

type UpdateInfo = { version: string }
type ProgressInfo = { percent: number }
type UpdaterEvents = {
  on(event: 'checking-for-update', callback: () => void): unknown
  on(event: 'update-available' | 'update-not-available' | 'update-downloaded', callback: (info: UpdateInfo) => void): unknown
  on(event: 'download-progress', callback: (info: ProgressInfo) => void): unknown
  on(event: 'error', callback: (error: Error) => void): unknown
}
type Updater = UpdaterEvents & {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  allowPrerelease: boolean
  allowDowngrade: boolean
  setFeedURL(options: { provider: 'github'; owner: string; repo: string; private: boolean; token?: string }): void
  checkForUpdates(): Promise<unknown>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
}
type Runtime = { isPackaged: boolean; getVersion(): string; platform: string }

export class UpdateManager {
  private state: UpdateStatus
  private checkJob: Promise<UpdateStatus> | null = null
  private downloadJob: Promise<UpdateStatus> | null = null
  private lastProgress = -1

  constructor(
    private readonly updater: Updater = autoUpdater,
    private readonly credentials = new GitHubCredentials(),
    private readonly runtime: Runtime = {
      isPackaged: app.isPackaged, getVersion: () => app.getVersion(), platform: process.platform
    },
    private readonly publish: (state: UpdateStatus) => void = (state) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send('spindle:update:status', state)
      }
    }
  ) {
    this.state = {
      phase: runtime.isPackaged && ['win32', 'linux'].includes(runtime.platform) ? 'idle' : 'disabled',
      currentVersion: runtime.getVersion(), availableVersion: null, percent: null, message: null
    }
    this.updater.autoDownload = false
    this.updater.autoInstallOnAppQuit = false
    this.updater.allowPrerelease = isPrereleaseVersion(this.state.currentVersion)
    this.updater.allowDowngrade = false

    this.updater.on('checking-for-update', () => {
      if (this.state.phase !== 'downloading' && this.state.phase !== 'ready') this.change({ phase: 'checking' })
    })
    this.updater.on('update-available', (info) => {
      if (!isNewerRelease(this.state.currentVersion, info.version)) {
        this.change({ phase: 'up-to-date', availableVersion: null })
        return
      }
      this.change({ phase: 'available', availableVersion: info.version, percent: null, message: null })
    })
    this.updater.on('update-not-available', () => {
      if (this.state.phase !== 'ready' && this.state.phase !== 'downloading') {
        this.change({ phase: 'up-to-date', availableVersion: null, message: null })
      }
    })
    this.updater.on('download-progress', (progress) => {
      if (this.state.phase !== 'downloading') return
      const percent = Math.max(0, Math.min(100, Math.floor(progress.percent)))
      if (percent !== this.lastProgress) {
        this.lastProgress = percent
        this.change({ percent })
      }
    })
    this.updater.on('update-downloaded', (info) => {
      if (this.state.phase === 'downloading' && this.state.availableVersion === info.version) {
        this.change({ phase: 'ready', percent: 100, message: null })
      }
    })
    this.updater.on('error', (error) => this.fail(error))
  }

  snapshot(): UpdateStatus { return { ...this.state } }

  private change(patch: Partial<UpdateStatus>): UpdateStatus {
    this.state = { ...this.state, ...patch }
    this.publish(this.snapshot())
    return this.snapshot()
  }

  private fail(error: unknown): UpdateStatus {
    // Failed background checks must never crash the application.
    if (this.state.phase === 'installing') return this.snapshot()
    return this.change({
      phase: 'error', percent: null, message: updateErrorMessage(error)
    })
  }

  check(): Promise<UpdateStatus> {
    if (this.state.phase === 'disabled' || this.state.phase === 'downloading' ||
        this.state.phase === 'ready' || this.state.phase === 'installing') return Promise.resolve(this.snapshot())
    if (this.checkJob) return this.checkJob
    this.change({ phase: 'checking', percent: null, message: null })
    this.checkJob = (async () => {
      try {
        // GitHub is currently private. Authentication stays exclusively in main.
        // Anonymous public update checks work once the repository is made public.
        const auth = await this.credentials.get()
        this.updater.setFeedURL({
          provider: 'github', owner: 'ZekStack', repo: 'spindle',
          private: Boolean(auth.token),
          ...(auth.token ? { token: auth.token } : {})
        })
        await this.updater.checkForUpdates()
      } catch (error) { this.fail(error) }
      return this.snapshot()
    })().finally(() => { this.checkJob = null })
    return this.checkJob
  }

  download(): Promise<UpdateStatus> {
    if (this.state.phase === 'ready') return Promise.resolve(this.snapshot())
    if (this.state.phase !== 'available') return Promise.reject(new Error('No update is ready for download'))
    if (this.downloadJob) return this.downloadJob
    this.lastProgress = -1
    this.change({ phase: 'downloading', percent: 0, message: null })
    this.downloadJob = (async () => {
      try { await this.updater.downloadUpdate() }
      catch (error) { this.fail(error) }
      return this.snapshot()
    })().finally(() => { this.downloadJob = null })
    return this.downloadJob
  }

  install(): UpdateStatus {
    if (this.state.phase !== 'ready') throw new Error('A verified update has not finished downloading')
    this.change({ phase: 'installing' })
    // Return the IPC reply before the installer closes the application.
    setTimeout(() => {
      try { this.updater.quitAndInstall(false, true) }
      catch (error) { this.fail(error) }
    }, 150)
    return this.snapshot()
  }
}
