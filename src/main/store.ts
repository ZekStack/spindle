import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { validateLogin, validateRepository, type Workspace } from '../shared/contracts'

const empty = (): Workspace => ({ organizations: [], trackedRepositories: [] })

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
    return { organizations: [...new Set(organizations)],
      trackedRepositories: [...new Set(trackedRepositories)] }
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
    state.trackedRepositories = state.trackedRepositories.filter((name) =>
      name.split('/')[0].toLowerCase() !== login.toLowerCase())
    return this.save(state)
  }
  trackRepository(ownerValue: string, repoValue: string, tracked: boolean): Workspace {
    const owner = validateLogin(ownerValue)
    const name = validateRepository(repoValue)
    if (typeof tracked !== 'boolean') throw new Error('Invalid tracking option')
    const state = this.load()
    const actualOwner = state.organizations.find((org) => org.toLowerCase() === owner.toLowerCase())
    if (!actualOwner) throw new Error('Add the organization first')
    const fullName = `${actualOwner}/${name}`
    state.trackedRepositories = state.trackedRepositories.filter((entry) =>
      entry.toLowerCase() !== fullName.toLowerCase())
    if (tracked) state.trackedRepositories.push(fullName)
    return this.save(state)
  }
}
