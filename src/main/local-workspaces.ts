import { randomUUID } from 'node:crypto'
import {
  existsSync, mkdirSync, readFileSync, realpathSync, renameSync,
  statSync, writeFileSync
} from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { parseRepositoryFullName, type LocalWorkspace } from '../shared/contracts'
import { runGit } from './git-process'

const MAX_ROOTS = 32
const MAX_REPOSITORIES = 256
const MAX_PATH_LENGTH = 2048
const MAX_SETTINGS_BYTES = 256_000

function safePath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 &&
    value.length <= MAX_PATH_LENGTH && isAbsolute(value) && !value.includes('\0')
}
function key(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value
}
function canonicalFolder(picked: string): string {
  if (!safePath(picked)) throw new Error('Invalid local folder')
  try {
    // Use the OS-native resolver to normalize Windows 8.3 aliases before persisting.
    const path = realpathSync.native(picked)
    if (!safePath(path) || !statSync(path).isDirectory()) throw new Error()
    return path
  } catch {
    throw new Error('Selected directory is not available')
  }
}
function canonicalRepo(value: unknown): string {
  const { owner, name } = parseRepositoryFullName(value)
  return `${owner}/${name}`
}

/** Recognize a real GitHub origin without passing raw URLs/credentials to IPC. */
export function githubOriginRepository(raw: string): string | null {
  if (typeof raw !== 'string' || raw.length > 1024 || raw.includes('\0')) return null
  const value = raw.trim()
  let path: string
  if (value.startsWith('git@github.com:')) {
    path = value.slice('git@github.com:'.length)
  } else {
    try {
      const url = new URL(value)
      const https = url.protocol === 'https:' && url.hostname === 'github.com' &&
        !url.username && !url.password && !url.port
      const ssh = url.protocol === 'ssh:' && url.hostname === 'github.com' &&
        url.username === 'git' && !url.password && !url.port
      if ((!https && !ssh) || url.search || url.hash) return null
      path = url.pathname.slice(1)
    } catch { return null }
  }
  if (path.endsWith('.git')) path = path.slice(0, -4)
  try { return canonicalRepo(path) } catch { return null }
}
function validateStored(raw: unknown): LocalWorkspace {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid local workspace settings')
  const obj = raw as Record<string, unknown>
  if (!Array.isArray(obj.roots) || obj.roots.length > MAX_ROOTS ||
      !Array.isArray(obj.repositories) || obj.repositories.length > MAX_REPOSITORIES) {
    throw new Error('Invalid local workspace settings')
  }
  const roots: string[] = []
  const repositories: LocalWorkspace['repositories'] = []
  const seenRoots = new Set<string>()
  const seenRepos = new Set<string>()
  const seenPaths = new Set<string>()
  for (const root of obj.roots) {
    if (!safePath(root) || seenRoots.has(key(root))) throw new Error('Invalid local workspace root')
    seenRoots.add(key(root))
    roots.push(root)
  }
  for (const item of obj.repositories) {
    if (!item || typeof item !== 'object') throw new Error('Invalid checkout association')
    const record = item as Record<string, unknown>
    if (typeof record.repository !== 'string' || !safePath(record.path)) {
      throw new Error('Invalid checkout association')
    }
    const repository = canonicalRepo(record.repository)
    const id = repository.toLowerCase()
    if (seenRepos.has(id) || seenPaths.has(key(record.path))) {
      throw new Error('Duplicate checkout association')
    }
    seenRepos.add(id)
    seenPaths.add(key(record.path))
    repositories.push({ repository, path: record.path })
  }
  return { roots, repositories }
}

/**
 * Independent from workspace.json to preserve preexisting GitHub preferences.
 * Only Electron native folder picker paths can be added/linked. Removal and
 * inspection use an exact already-saved key, not an arbitrary renderer path.
 */
export class LocalWorkspaceStore {
  constructor(private readonly file: string) {}
  load(): LocalWorkspace {
    if (!existsSync(this.file)) return { roots: [], repositories: [] }
    if (statSync(this.file).size > MAX_SETTINGS_BYTES) throw new Error('Oversized local workspace settings')
    return validateStored(JSON.parse(readFileSync(this.file, 'utf8')) as unknown)
  }
  private save(value: LocalWorkspace): LocalWorkspace {
    mkdirSync(dirname(this.file), { recursive: true })
    const temp = `${this.file}.${process.pid}.${randomUUID()}.tmp`
    writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    renameSync(temp, this.file)
    return value
  }
  addRootFromPicker(picked: string): LocalWorkspace {
    const path = canonicalFolder(picked)
    const state = this.load()
    if (state.roots.some((root) => key(root) === key(path))) return state
    if (state.roots.length >= MAX_ROOTS) throw new Error('Too many workspace roots')
    state.roots.push(path)
    return this.save(state)
  }
  removeRoot(savedPath: string): LocalWorkspace {
    const state = this.load()
    const target = state.roots.find((root) => root === savedPath)
    if (!target) throw new Error('Workspace root not found')
    state.roots = state.roots.filter((root) => root !== target)
    // Associations are intentionally independent; removing a root never
    // deletes checkouts, GitHub tracking or other saved local paths.
    return this.save(state)
  }
  async linkFromPicker(repositoryValue: string, picked: string): Promise<LocalWorkspace> {
    const repository = canonicalRepo(repositoryValue)
    const pickedFolder = canonicalFolder(picked)
    const signal = AbortSignal.timeout(15_000)
    let path: string
    let origin: string
    try {
      path = canonicalFolder((await runGit([
        '-c', 'core.fsmonitor=false', '-C', pickedFolder,
        'rev-parse', '--show-toplevel'
      ], signal)).trim())
      origin = (await runGit(['-C', path, 'config', '--get', 'remote.origin.url'], signal)).trim()
    } catch {
      // Git may print credentials, filesystem paths or local config details.
      // Never expose raw Git errors through this API.
      throw new Error('Selected folder must be a Git checkout with a GitHub origin')
    }
    if (githubOriginRepository(origin)?.toLowerCase() !== repository.toLowerCase()) {
      throw new Error('Git checkout origin does not match the selected GitHub repository')
    }
    const state = this.load()
    if (state.repositories.some((item) =>
      key(item.path) === key(path) && item.repository.toLowerCase() !== repository.toLowerCase())) {
      throw new Error('This checkout is already linked to another repository')
    }
    const previous = state.repositories.find((item) =>
      item.repository.toLowerCase() === repository.toLowerCase())
    if (previous?.path === path) return state
    if (!previous && state.repositories.length >= MAX_REPOSITORIES) {
      throw new Error('Too many repository locations')
    }
    state.repositories = state.repositories.filter((item) =>
      item.repository.toLowerCase() !== repository.toLowerCase())
    state.repositories.push({ repository: previous?.repository ?? repository, path })
    return this.save(state)
  }
  unlink(repositoryValue: string): LocalWorkspace {
    const repository = canonicalRepo(repositoryValue)
    const state = this.load()
    if (!state.repositories.some((item) =>
      item.repository.toLowerCase() === repository.toLowerCase())) {
      throw new Error('Repository location not found')
    }
    state.repositories = state.repositories.filter((item) =>
      item.repository.toLowerCase() !== repository.toLowerCase())
    return this.save(state)
  }
  /** A clone may only target a root previously chosen through the native picker. */
  cloneDestination(repositoryValue: string, savedRoot: string): string {
    const { name, owner } = parseRepositoryFullName(repositoryValue)
    const state = this.load()
    if (state.repositories.some((item) =>
      item.repository.toLowerCase() === `${owner}/${name}`.toLowerCase())) {
      throw new Error('Repository already has a linked checkout')
    }
    if (typeof savedRoot !== 'string' || !state.roots.includes(savedRoot)) {
      throw new Error('Select a saved local workspace folder')
    }
    // A renamed or replaced root must be reselected, never silently followed.
    if (key(canonicalFolder(savedRoot)) !== key(savedRoot)) {
      throw new Error('Workspace folder has moved; select it again')
    }
    return join(savedRoot, name)
  }

  pathFor(repositoryValue: string): string {
    const repository = canonicalRepo(repositoryValue)
    const state = this.load()
    const match = state.repositories.find((item) =>
      item.repository.toLowerCase() === repository.toLowerCase())
    if (!match) throw new Error('Repository has no linked local checkout')
    // Do not silently relink or change an association after a directory moves.
    return match.path
  }
}
