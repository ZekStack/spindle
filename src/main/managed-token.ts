import { app, safeStorage } from 'electron'
import { randomUUID } from 'node:crypto'
import { readFile, rename, rm, lstat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface SecureCipher {
  isAsyncEncryptionAvailable(): Promise<boolean>
  getSelectedStorageBackend(): string
  encryptStringAsync(value: string): Promise<Buffer>
  decryptStringAsync(data: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>
}

/**
 * A single Spindle-managed token encrypted by the OS. Never use Electron's
 * Linux "basic_text" fallback: it derives its key from a fixed password.
 * Credentials remain inaccessible to the renderer and workspace JSON.
 */
export class ManagedGitHubTokenStore {
  constructor(
    private readonly cipher: SecureCipher = safeStorage,
    private readonly file: () => string =
      () => join(app.getPath('userData'), 'github-token.enc'),
    private readonly platform: string = process.platform
  ) {}

  async available(): Promise<boolean> {
    try {
      if (!(await this.cipher.isAsyncEncryptionAvailable())) return false
      if (this.platform === 'linux') {
        return ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']
          .includes(this.cipher.getSelectedStorageBackend())
      }
      return this.platform === 'win32' || this.platform === 'darwin'
    } catch { return false }
  }

  async load(): Promise<string | null> {
    if (!(await this.available())) return null
    try {
      const path = this.file()
      const info = await lstat(path)
      if (!info.isFile() || info.isSymbolicLink() || info.size > 16_384) return null
      const data = await readFile(path)
      const { result, shouldReEncrypt } = await this.cipher.decryptStringAsync(data)
      if (!isToken(result)) return null
      if (shouldReEncrypt) {
        // A key rotation should not leave a decryptable old key on disk.
        await this.save(result)
      }
      return result
    } catch { return null }
  }

  async save(token: string): Promise<void> {
    if (!isToken(token) || !(await this.available())) {
      throw new Error('Secure credential storage is unavailable')
    }
    const encrypted = await this.cipher.encryptStringAsync(token)
    if (!encrypted.length || encrypted.length > 16_384) {
      throw new Error('Secure credential storage is unavailable')
    }
    const target = this.file()
    const tmp = target + '.' + randomUUID() + '.tmp'
    try {
      await writeFile(tmp, encrypted, { flag: 'wx', mode: 0o600 })
      await rename(tmp, target)
    } finally {
      await rm(tmp, { force: true }).catch(() => {})
    }
  }

  async clear(): Promise<void> {
    await rm(this.file(), { force: true })
  }
}

function isToken(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 20 &&
    value.length <= 2048 && /^[A-Za-z0-9_.-]+$/.test(value)
}

export const managedGitHubToken = new ManagedGitHubTokenStore()
