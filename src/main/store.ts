import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { validateLogin, validateRepository, type Workspace } from '../shared/contracts'

const empty = (): Workspace => ({ organizations: [], trackedRepositories: [] })

function uniqueIgnoreCase(values: string[]): string[] {
  const seen = new Set<string>()
  return values.filter((value) => {
    const key = value.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export class WorkspaceStore {
  constructor(private readonly file: string) {}
  load(): Workspace {
    if (!existsSync(this.file)) return empty()
    // A corrupt settings file must not be silently overwritten.
    const raw: unknown = JSON.parse(readFileSync(this.file, 'utf8'))
    if (!raw || typeof raw !== 'object') throw new Error('Invalid workspace settings')
    const data = raw as Record<string, unknown>
    if (!Array.isArray(data.organizations) || !Array.isArray(data.trackedRepositories)) {
      throw new Error('Invalid workspace settings')
    }
    const organizations = data.organizations.map(validateLogin)
    const trackedRepositories = data.trackedRepositories.map((value: unknown) => {
      if (typeof value !== 'string' || value.split('/').length !== 2) throw new Error('Invalid tracked repository')
      const [owner, name] = value.split('/')
      return `${validateLogin(owner)}/${validateRepository(name)}`
    })
    return {
      organizations: uniqueIgnoreCase(organizations),
      trackedRepositories: uniqueIgnoreCase(trackedRepositories)
    }
  }
  private save(workspace: Workspace): Workspace {
    mkdirSync(dirname(this.file), { recursive: true })
    const temp = `${this.file}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify(workspace, null, 2) + '\n', { mode: 0o600 })
    renameSync(temp, this.file)
    return workspace
  }
  addOrganization(value: string): Workspace {
    const login = validateLogin(value)
    const state = this.load()
    if (!state.organizations.some((org) => org.toLowerCase() === login.toLowerCase())) {
      state.organizations.push(login)
    }
    return this.save(state)
  }
  removeOrganization(value: string): Workspace {
    const login = validateLogin(value)
    const state = this.load()
    state.organizations = state.organizations.filter((org) => org.toLowerCase() !== login.toLowerCase())
    return this.save(state)
  }
  trackRepository(ownerValue: string, repoValue: string, tracked: boolean): Workspace {
    const owner = validateLogin(ownerValue)
    const name = validateRepository(repoValue)
    if (typeof tracked !== 'boolean') throw new Error('Invalid tracking option')
    const state = this.load()
    // Repositories are independent workspace shortcuts: an account's
    // personal repository or a repo outside saved organizations is valid.
    // IPC verifies GitHub accessibility before adding; untracking is local.
    const savedOwner = state.organizations.find((org) =>
      org.toLowerCase() === owner.toLowerCase())
    const fullName = `${savedOwner ?? owner}/${name}`
    const existing = state.trackedRepositories.find((entry) =>
      entry.toLowerCase() === fullName.toLowerCase())
    if (tracked && !existing) state.trackedRepositories.push(fullName)
    if (!tracked) {
      state.trackedRepositories = state.trackedRepositories.filter((entry) =>
        entry.toLowerCase() !== fullName.toLowerCase())
    }
    return this.save(state)
  }
}
