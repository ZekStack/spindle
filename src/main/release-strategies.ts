import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { parseRepositoryFullName } from '../shared/contracts'
import {
  validateReleaseStrategy, validateStrategyEntry, type ReleaseStrategy,
  type ReleaseStrategyEntry
} from '../shared/release-strategies'

const LIMIT = 256
const MAX_BYTES = 100_000
function normalize(repository: string): string {
  const { owner, name } = parseRepositoryFullName(repository)
  return `${owner}/${name}`
}

/** Private, independent, versioned and atomic user preferences. Corrupt data fails closed. */
export class ReleaseStrategyStore {
  constructor(private readonly file: string) {}
  load(): ReleaseStrategyEntry[] {
    if (!existsSync(this.file)) return []
    if (statSync(this.file).size > MAX_BYTES) throw new Error('Oversized release strategies')
    const data: unknown = JSON.parse(readFileSync(this.file, 'utf8'))
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('Invalid release strategies')
    }
    const stored = data as Record<string, unknown>
    if (stored.version !== 1 || !Array.isArray(stored.repositories) ||
        stored.repositories.length > LIMIT) throw new Error('Invalid release strategies')
    const entries = stored.repositories.map(validateStrategyEntry)
    const names = entries.map(x => x.repository.toLowerCase())
    if (new Set(names).size !== names.length) throw new Error('Duplicate release strategy')
    return entries
  }
  get(repository: string): ReleaseStrategy {
    const id = normalize(repository).toLowerCase()
    // API is the preexisting manual draft behavior, not an automatic mutation.
    return this.load().find(entry => entry.repository.toLowerCase() === id)?.strategy ?? { kind: 'api' }
  }
  save(repository: string, raw: ReleaseStrategy): ReleaseStrategy {
    const canonical = normalize(repository)
    const strategy = validateReleaseStrategy(raw)
    const entries = this.load().filter(x =>
      x.repository.toLowerCase() !== canonical.toLowerCase())
    if (entries.length >= LIMIT) throw new Error('Too many release strategies')
    entries.push({ repository: canonical, strategy })
    mkdirSync(dirname(this.file), { recursive: true })
    const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`
    writeFileSync(temporary, JSON.stringify({ version: 1, repositories: entries }, null, 2) + '\n',
      { flag: 'wx', mode: 0o600 })
    renameSync(temporary, this.file)
    return strategy
  }
}
