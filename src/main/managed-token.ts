import { randomUUID } from 'node:crypto'
import { readFile, rename, rm, lstat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { validateLogin, type ManagedAccountList } from '../shared/contracts'

// Electron's APIs are loaded only on demand so the storage implementation can
// also run in ordinary Node unit tests with injected OS encryption.
const electronCipher: SecureCipher = {
  async isAsyncEncryptionAvailable() {
    const { safeStorage } = await import('electron')
    return safeStorage.isAsyncEncryptionAvailable()
  },
  async getSelectedStorageBackend() {
    const { safeStorage } = await import('electron')
    return safeStorage.getSelectedStorageBackend()
  },
  async encryptStringAsync(value) {
    const { safeStorage } = await import('electron')
    return safeStorage.encryptStringAsync(value)
  },
  async decryptStringAsync(data) {
    const { safeStorage } = await import('electron')
    return safeStorage.decryptStringAsync(data)
  }
}

async function defaultTokenPath(): Promise<string> {
  const { app } = await import('electron')
  return join(app.getPath('userData'), 'github-token.enc')
}

export interface SecureCipher {
  isAsyncEncryptionAvailable(): Promise<boolean>
  getSelectedStorageBackend(): string | Promise<string>
  encryptStringAsync(value: string): Promise<Buffer>
  decryptStringAsync(data: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>
}

type Entry = { login: string; token: string }
type Vault = { version: 2; selected: string | null; accounts: Entry[] }
const LEGACY = '__legacy__'
const MAX_ACCOUNTS = 30
const empty = (): Vault => ({ version: 2, selected: null, accounts: [] })

function validToken(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 20 &&
    value.length <= 2048 && /^[A-Za-z0-9_.-]+$/.test(value)
}
function normalize(login: string): string { return login.toLowerCase() }
function entry(vault: Vault, login: string): Entry | undefined {
  return vault.accounts.find((item) => normalize(item.login) === normalize(login))
}
function decode(plain: string): Vault {
  // Old M1.2 installations stored one protected token in the same file.
  // Preserve it until GET /user associates it with the verified login.
  if (validToken(plain)) {
    return { version: 2, selected: LEGACY, accounts: [{ login: LEGACY, token: plain }] }
  }
  let raw: unknown
  try { raw = JSON.parse(plain) } catch { throw new Error('Invalid encrypted account vault') }
  if (!raw || typeof raw !== 'object') throw new Error('Invalid encrypted account vault')
  const vault = raw as Partial<Vault>
  if (vault.version !== 2 || !Array.isArray(vault.accounts) ||
      vault.accounts.length > MAX_ACCOUNTS ||
      !(vault.selected === null || typeof vault.selected === 'string')) {
    throw new Error('Invalid encrypted account vault')
  }
  const seen = new Set<string>()
  for (const account of vault.accounts) {
    if (!account || typeof account.login !== 'string' ||
        (account.login !== LEGACY && !validLogin(account.login)) ||
        !validToken(account.token) || seen.has(normalize(account.login))) {
      throw new Error('Invalid encrypted account vault')
    }
    seen.add(normalize(account.login))
  }
  if (vault.selected !== null && !entry(vault as Vault, vault.selected)) {
    throw new Error('Invalid encrypted account vault')
  }
  return vault as Vault
}

function validLogin(value: string): boolean {
  try { return validateLogin(value) === value } catch { return false }
}

/**
 * All Spindle-owned accounts are held in a single OS-encrypted, atomically
 * replaced vault. The workspace, renderer, and logs never receive tokens.
 * Switching accounts is local; it never mutates gh CLI or environment auth.
 */
export class ManagedGitHubTokenStore {
  private queued: Promise<void> = Promise.resolve()
  constructor(
    private readonly cipher: SecureCipher = electronCipher,
    private readonly file: () => string | Promise<string> = defaultTokenPath,
    private readonly platform: string = process.platform
  ) {}

  async available(): Promise<boolean> {
    try {
      if (!(await this.cipher.isAsyncEncryptionAvailable())) return false
      if (this.platform === 'linux') {
        return ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']
          .includes(await this.cipher.getSelectedStorageBackend())
      }
      return this.platform === 'win32' || this.platform === 'darwin'
    } catch { return false }
  }

  private async read(): Promise<Vault> {
    if (!(await this.available())) throw new Error('Secure credential storage is unavailable')
    const path = await this.file()
    let data: Buffer
    try {
      const info = await lstat(path)
      if (!info.isFile() || info.isSymbolicLink() || info.size > 100_000) {
        throw new Error('Invalid encrypted account vault')
      }
      data = await readFile(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty()
      throw error
    }
    const { result, shouldReEncrypt } = await this.cipher.decryptStringAsync(data)
    const vault = decode(result)
    if (shouldReEncrypt) await this.write(vault)
    return vault
  }

  private async write(vault: Vault): Promise<void> {
    const encrypted = await this.cipher.encryptStringAsync(JSON.stringify(vault))
    if (!encrypted.length || encrypted.length > 100_000) {
      throw new Error('Secure credential storage is unavailable')
    }
    const target = await this.file()
    const tmp = target + '.' + randomUUID() + '.tmp'
    try {
      await writeFile(tmp, encrypted, { flag: 'wx', mode: 0o600 })
      await rename(tmp, target)
    } finally {
      await rm(tmp, { force: true }).catch(() => {})
    }
  }

  private modify<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queued.then(operation)
    this.queued = next.then(() => {}, () => {})
    return next
  }

  async load(): Promise<string | null> {
    try {
      const vault = await this.read()
      return vault.selected ? entry(vault, vault.selected)?.token ?? null : null
    } catch { return null }
  }

  async accounts(): Promise<ManagedAccountList> {
    if (!(await this.available())) return { logins: [], activeLogin: null, legacyActive: false }
    const vault = await this.read()
    return {
      logins: vault.accounts.filter((item) => item.login !== LEGACY).map((item) => item.login),
      activeLogin: vault.selected === LEGACY ? null : vault.selected,
      legacyActive: vault.selected === LEGACY
    }
  }

  /**
   * Called only after verifying GET /user. Preserve other signed-in accounts.
   * The optional login retains support for the previous standalone token API.
   */
  async save(token: string, login?: string): Promise<void> {
    if (!validToken(token)) throw new Error('Invalid GitHub credential')
    await this.modify(async () => {
      const vault = await this.read()
      if (!login) {
        // Older clients/tests used save(token) before an account was known.
        if (vault.accounts.length) throw new Error('Verified login is required')
        await this.write({ version: 2, selected: LEGACY, accounts: [{ login: LEGACY, token }] })
        return
      }
      if (!validLogin(login)) throw new Error('Invalid account login')
      const previous = entry(vault, login)
      if (!previous && vault.accounts.length >= MAX_ACCOUNTS) throw new Error('Too many GitHub accounts')
      vault.accounts = vault.accounts.filter((item) => normalize(item.login) !== normalize(login))
      vault.accounts.push({ login, token })
      vault.selected = login
      await this.write(vault)
    })
  }

  /** Associate an existing single-account ciphertext with its verified GitHub login. */
  async adoptLegacy(login: string): Promise<void> {
    if (!validLogin(login)) return
    await this.modify(async () => {
      const vault = await this.read()
      if (vault.selected !== LEGACY) return
      const legacy = entry(vault, LEGACY)
      if (!legacy) return
      vault.accounts = vault.accounts.filter((item) => item.login !== LEGACY)
      vault.accounts.push({ login, token: legacy.token })
      vault.selected = login
      await this.write(vault)
    })
  }

  async select(login: string | null): Promise<ManagedAccountList> {
    return this.modify(async () => {
      const vault = await this.read()
      if (login !== null) {
        if (!validLogin(login)) throw new Error('Invalid account login')
        const selected = entry(vault, login)
        if (!selected || selected.login === LEGACY) throw new Error('Account not found')
        vault.selected = selected.login
      } else {
        vault.selected = null // Explicitly use external CLI/env or anonymous access
      }
      await this.write(vault)
      return this.accounts()
    })
  }

  async remove(login: string): Promise<ManagedAccountList> {
    if (!validLogin(login)) throw new Error('Invalid account login')
    return this.modify(async () => {
      const vault = await this.read()
      const match = entry(vault, login)
      if (!match || match.login === LEGACY) throw new Error('Account not found')
      vault.accounts = vault.accounts.filter((item) => normalize(item.login) !== normalize(login))
      if (vault.selected && normalize(vault.selected) === normalize(login)) {
        vault.selected = vault.accounts.find((item) => item.login !== LEGACY)?.login ?? null
      }
      await this.write(vault)
      return this.accounts()
    })
  }

  /** Sign out of only the active managed account, leaving others intact. */
  async clear(): Promise<void> {
    await this.modify(async () => {
      const vault = await this.read()
      if (!vault.selected) return
      vault.accounts = vault.accounts.filter((item) => item.login !== vault.selected)
      vault.selected = vault.accounts.find((item) => item.login !== LEGACY)?.login ?? null
      await this.write(vault)
    })
  }
}

export const managedGitHubToken = new ManagedGitHubTokenStore()
