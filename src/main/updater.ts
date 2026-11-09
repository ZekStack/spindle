import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import updaterPackage from 'electron-updater'
const { autoUpdater } = updaterPackage
import { GitHubCredentials } from './github'
import { DebInstallError, installVerifiedDeb } from './deb-install'
import { selectDownloadedDeb } from './deb-download'
import { SpindleDebUpdater } from './strict-deb-updater'
import { detectLinuxPackage } from './package-type'
import { verifyRunningDebPackage } from './deb-preflight'
import { failedUpdateOperation, formatUpdateDiagnostics } from '../shared/update-diagnostics'
import { clearInstallAttempt, previousInstallUnapplied, recordInstallAttempt } from './update-attempt'
import { isEligibleUpdate, isPrereleaseVersion, updateErrorMessage, type UpdatePreferences, type UpdateStatus } from '../shared/update-policy'
import { UpdatePreferencesStore, validateUpdatePreferences } from './update-preferences'

type UpdateInfo = {
  version: string
  downloadedFile?: string
  files?: { url: string; sha512?: string }[]
}
type ProgressInfo = { percent: number }
type UpdaterEvents = {
  on(event: 'checking-for-update', callback: () => void): unknown
  on(event: 'update-available' | 'update-not-available' | 'update-downloaded', callback: (info: UpdateInfo) => void): unknown
  on(event: 'download-progress', callback: (info: ProgressInfo) => void): unknown
  on(event: 'error', callback: (error: Error) => void): unknown
}
type Updater = UpdaterEvents & {
  logger?: unknown
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

function desktopUpdater(): Updater {
  if (process.platform === 'linux' && detectLinuxPackage(process.resourcesPath) === 'deb') {
    return new SpindleDebUpdater()
  }
  return autoUpdater
}


export class UpdateManager {
  private state: UpdateStatus
  private checkJob: Promise<UpdateStatus> | null = null
  private downloadJob: Promise<UpdateStatus> | null = null
  private lastProgress = -1
  private downloadedDeb: { file: string; version: string; sha512: string } | null = null
  private installJob: Promise<UpdateStatus> | null = null
  private readonly attemptFile: string | null
  private readonly linuxPackage: ReturnType<typeof detectLinuxPackage>
  private lastCompletedCheckAt: number | null = null
  private includePrereleases = false
  private preferencesError = false

  constructor(
    private readonly updater: Updater = desktopUpdater(),
    private readonly credentials = new GitHubCredentials(),
    private readonly runtime: Runtime = {
      isPackaged: app.isPackaged, getVersion: () => app.getVersion(), platform: process.platform
    },
    private readonly publish: (state: UpdateStatus) => void = (state) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send('spindle:update:status', state)
      }
    },
    private readonly preferences = new UpdatePreferencesStore(join(app.getPath('userData'), 'update-preferences.json'))
  ) {
    this.linuxPackage = runtime.platform === 'linux' ? detectLinuxPackage(process.resourcesPath) : 'unknown'
    this.attemptFile = runtime.isPackaged ? join(app.getPath('userData'), 'update-attempt.json') : null
    const previousFailure = this.attemptFile !== null &&
      previousInstallUnapplied(this.attemptFile, runtime.getVersion())
    this.state = {
      phase: previousFailure ? 'error' :
        runtime.isPackaged && (runtime.platform === 'win32' ||
          (runtime.platform === 'linux' && this.linuxPackage !== 'unknown'))
          ? 'idle' : 'disabled',
      currentVersion: runtime.getVersion(), availableVersion: null, percent: null,
      message: previousFailure ? 'not-installed' : null,
      installType: runtime.isPackaged
        ? runtime.platform === 'win32' ? 'nsis' : this.linuxPackage
        : 'unknown',
      failureStage: previousFailure ? 'install' : null
    }
    // electron-updater defaults to console logging, which can include URLs
    // or headers during authenticated release requests. Never log raw output.
    this.updater.logger = null
    this.updater.autoDownload = false
    this.updater.autoInstallOnAppQuit = false
    try {
      this.includePrereleases = this.preferences.load(isPrereleaseVersion(this.state.currentVersion)).includePrereleases
    } catch {
      // Fail closed and surface the storage error in Settings. Never overwrite corrupt preferences.
      this.preferencesError = true
      this.includePrereleases = false
    }
    this.applyChannel()

    this.updater.on('checking-for-update', () => {
      if (this.state.phase !== 'downloading' && this.state.phase !== 'ready') this.change({ phase: 'checking' })
    })
    this.updater.on('update-available', (info) => {
      this.downloadedDeb = null
      if (!isEligibleUpdate(this.state.currentVersion, info.version, this.includePrereleases)) {
        this.change({ phase: 'up-to-date', availableVersion: null, failureStage: null })
        return
      }
      this.change({ phase: 'available', availableVersion: info.version, percent: null, message: null, failureStage: null })
    })
    this.updater.on('update-not-available', () => {
      if (this.state.phase !== 'ready' && this.state.phase !== 'downloading') {
        this.change({ phase: 'up-to-date', availableVersion: null, message: null, failureStage: null })
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
        if (this.linuxPackage === 'deb') {
          try {
            // A Linux feed can contain both AppImage and DEB assets.
            // Never hand an AppImage to a Debian package installer, even
            // if electron-updater selects the wrong asset.
            this.downloadedDeb = selectDownloadedDeb(info)
          } catch (error) {
            this.downloadedDeb = null
            this.fail(error)
            return
          }
        }
        this.change({ phase: 'ready', percent: 100, message: null, failureStage: null })
      }
    })
    this.updater.on('error', (error) => this.fail(error))
  }

  snapshot(): UpdateStatus { return { ...this.state } }

  getPreferences(): UpdatePreferences {
    if (this.preferencesError) throw new Error('Update preferences could not be loaded')
    return { includePrereleases: this.includePrereleases }
  }

  private applyChannel(): void {
    this.updater.allowPrerelease = this.includePrereleases
    // Some electron-updater channel setters implicitly enable downgrades.
    this.updater.allowDowngrade = false
  }

  async setPreferences(value: unknown): Promise<UpdatePreferences> {
    const next = validateUpdatePreferences(value)
    if (this.preferencesError) throw new Error('Update preferences could not be loaded')
    if (this.checkJob) await this.checkJob
    if (['downloading', 'ready', 'installing'].includes(this.state.phase)) {
      throw new Error('Finish or restart the current update before changing channels')
    }
    if (next.includePrereleases === this.includePrereleases) return this.getPreferences()
    this.preferences.save(next)
    this.includePrereleases = next.includePrereleases
    this.applyChannel()
    // An unapplied install is a recovery error, not an available update.
    // Only a user-initiated manual check may clear its persisted warning.
    if (this.state.message === 'not-installed') return this.getPreferences()
    this.downloadedDeb = null
    const disabled = this.state.phase === 'disabled'
    // Discard stale offers: changing channel never installs an old candidate.
    this.change({
      phase: disabled ? 'disabled' : 'idle',
      availableVersion: null, percent: null, message: null, failureStage: null
    })
    if (!disabled) void this.check(true)
    return this.getPreferences()
  }

  diagnosticReport(): string {
    return formatUpdateDiagnostics(this.snapshot(), this.runtime.platform, this.lastCompletedCheckAt)
  }

  private change(patch: Partial<UpdateStatus>): UpdateStatus {
    this.state = { ...this.state, ...patch }
    this.publish(this.snapshot())
    return this.snapshot()
  }

  private fail(error: unknown): UpdateStatus {
    // Never expose process output or credential-bearing errors to the renderer.
    const code = error instanceof DebInstallError
      ? error.reason === 'not-deb-install' ? 'wrong-launcher'
        : error.reason === 'version-mismatch' ? 'not-installed'
        : error.reason === 'package-manager' ? 'install-failed' : 'verification'
      : updateErrorMessage(error)
    return this.change({ phase: 'error', percent: null, message: code,
      failureStage: failedUpdateOperation(this.state.phase, this.state.failureStage) })
  }

  check(manual = false): Promise<UpdateStatus> {
    if (!manual && this.state.message === 'not-installed') return Promise.resolve(this.snapshot())
    if (manual && this.state.message === 'not-installed' && this.attemptFile) {
      clearInstallAttempt(this.attemptFile)
    }
    if (this.state.phase === 'disabled' || this.state.phase === 'downloading' ||
        this.state.phase === 'ready' || this.state.phase === 'installing') return Promise.resolve(this.snapshot())
    if (this.checkJob) return this.checkJob
    this.change({ phase: 'checking', percent: null, message: null, failureStage: null })
    this.checkJob = (async () => {
      try {
        // GitHub is currently private. Authentication stays exclusively in main.
        // Anonymous public update checks work once the repository is made public.
        if (this.linuxPackage === 'deb') {
          await verifyRunningDebPackage(process.execPath, this.state.currentVersion)
        }
        const auth = await this.credentials.get()
        this.applyChannel()
        this.updater.setFeedURL({
          provider: 'github', owner: 'ZekStack', repo: 'spindle',
          private: Boolean(auth.token),
          ...(auth.token ? { token: auth.token } : {})
        })
        await this.updater.checkForUpdates()
      } catch (error) { this.fail(error) }
      return this.snapshot()
    })().finally(() => { this.lastCompletedCheckAt = Date.now(); this.checkJob = null })
    return this.checkJob
  }

  download(): Promise<UpdateStatus> {
    if (this.state.phase === 'ready') return Promise.resolve(this.snapshot())
    if (this.downloadJob) return this.downloadJob
    if (this.state.phase !== 'available') return Promise.reject(new Error('No update is ready for download'))
    if (!this.state.availableVersion ||
        !isEligibleUpdate(this.state.currentVersion, this.state.availableVersion, this.includePrereleases)) {
      return Promise.reject(new Error('The offered update is no longer eligible'))
    }
    this.lastProgress = -1
    this.downloadedDeb = null
    this.change({ phase: 'downloading', percent: 0, message: null, failureStage: null })
    this.downloadJob = (async () => {
      try {
        if (this.linuxPackage === 'deb') {
          await verifyRunningDebPackage(process.execPath, this.state.currentVersion)
        }
        await this.updater.downloadUpdate()
      } catch (error) { this.fail(error) }
      return this.snapshot()
    })().finally(() => { this.downloadJob = null })
    return this.downloadJob
  }

  install(): Promise<UpdateStatus> {
    if (this.installJob) return this.installJob
    if (this.state.phase !== 'ready' || !this.state.availableVersion) {
      return Promise.reject(new Error('A verified update has not finished downloading'))
    }
    const target = this.state.availableVersion
    if (!isEligibleUpdate(this.state.currentVersion, target, this.includePrereleases)) {
      return Promise.reject(new Error('The downloaded update is no longer eligible'))
    }
    this.change({ phase: 'installing', message: null, failureStage: null })
    this.installJob = (async () => {
      try {
        if (this.linuxPackage === 'deb') {
          // Linux DEB installation needs privilege elevation. Wait for dpkg's
          // actual result: quitAndInstall can relaunch even after an install fails.
          await verifyRunningDebPackage(process.execPath, this.state.currentVersion)
          const deb = this.downloadedDeb
          if (!deb || deb.version !== target) {
            throw new DebInstallError('verification', 'No verified DEB download for this version')
          }
          await installVerifiedDeb({
            file: deb.file, expectedVersion: target,
            sha512: deb.sha512, executable: process.execPath
          })
          if (this.attemptFile) recordInstallAttempt(this.attemptFile, this.state.currentVersion, target)
          // dpkg-query has confirmed the installed version before any restart.
          setTimeout(() => {
            try { app.relaunch(); app.quit() }
            catch (error) { this.fail(error) }
          }, 200)
        } else {
          if (this.attemptFile) recordInstallAttempt(this.attemptFile, this.state.currentVersion, target)
          // NSIS and AppImage retain the tested electron-updater path.
          setTimeout(() => {
            try { this.updater.quitAndInstall(false, true) }
            catch (error) { this.fail(error) }
          }, 150)
        }
      } catch (error) {
        this.fail(error)
      }
      return this.snapshot()
    })().finally(() => { this.installJob = null })
    return this.installJob
  }
}
