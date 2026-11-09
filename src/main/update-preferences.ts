import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { UpdatePreferences } from '../shared/update-policy'

export function validateUpdatePreferences(value: unknown): UpdatePreferences {
  if (!value || typeof value !== 'object' ||
      typeof (value as UpdatePreferences).includePrereleases !== 'boolean') {
    throw new Error('Invalid update preferences')
  }
  return { includePrereleases: (value as UpdatePreferences).includePrereleases }
}

/** Store only the update channel choice, never credentials or update URLs. */
export class UpdatePreferencesStore {
  constructor(private readonly file: string) {}

  load(defaultIncludePrereleases = false): UpdatePreferences {
    if (!existsSync(this.file)) return { includePrereleases: defaultIncludePrereleases }
    const stat = lstatSync(this.file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) {
      throw new Error('Invalid update preferences file')
    }
    const raw: unknown = JSON.parse(readFileSync(this.file, 'utf8'))
    if (!raw || typeof raw !== 'object' || (raw as { version?: unknown }).version !== 1) {
      throw new Error('Invalid update preferences file')
    }
    return validateUpdatePreferences(raw)
  }

  save(value: unknown): UpdatePreferences {
    const validated = validateUpdatePreferences(value)
    // Never replace corrupt or unrecognized user data silently.
    this.load()
    mkdirSync(dirname(this.file), { recursive: true })
    const temp = `${this.file}.${process.pid}.tmp`
    try {
      writeFileSync(temp, JSON.stringify({ version: 1, ...validated }, null, 2) + '\n', {
        mode: 0o600, flag: 'wx'
      })
      renameSync(temp, this.file)
    } finally {
      rmSync(temp, { force: true })
    }
    return validated
  }
}
