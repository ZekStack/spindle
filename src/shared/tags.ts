/** Read-only, bounded Git tag metadata, never remote URL or raw Git output. */
export type TagMode = 'annotated' | 'lightweight'
export type TagAction = 'create' | 'push' | 'delete-local' | 'delete-origin' | 'delete-both'

export interface GitTagRef {
  oid: string
  kind?: TagMode
}
export interface GitTagEntry {
  name: string
  local: GitTagRef | null
  origin: GitTagRef | null
}
export interface GitTagsSnapshot {
  head: string | null
  branch: string | null
  localTotal: number
  originTotal: number
  originState: 'available' | 'unavailable'
  originError: 'auth' | 'network' | 'unknown' | null
  entries: GitTagEntry[]
}

export interface TagMutationRequest {
  action: TagAction
  tag: string
  mode?: TagMode
  /** Only transient main-process work keeps this text; never stored in Activity. */
  message?: string
  /** Optimistic concurrency values from the explicit confirmation preview. */
  expectedHead?: string
  expectedLocalOid?: string
  expectedOriginOid?: string
}

export const MAX_TAG_ENTRIES = 80
export const TAG_OID_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/

/** Deliberately conservative, ASCII-only subset of legal Git tag refs. */
export function validateTagName(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 100 ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(value) ||
    value.includes('..') || value.includes('//') || value.includes('@{') ||
    value.endsWith('.') || value.endsWith('/') || value.endsWith('.lock') ||
    value.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.')) ||
    /(?:^|\/)refs(?:\/|$)/.test(value)) {
    throw new Error('Invalid Git tag name')
  }
  return value
}

function oid(value: unknown): value is string {
  return typeof value === 'string' && TAG_OID_PATTERN.test(value)
}

export function validateTagMutation(input: unknown): TagMutationRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Invalid tag operation')
  }
  const item = input as Record<string, unknown>
  if (!['create','push','delete-local','delete-origin','delete-both'].includes(item.action as string)) {
    throw new Error('Invalid tag operation')
  }
  const tag = validateTagName(item.tag)
  const action = item.action as TagAction
  const result: TagMutationRequest = { action, tag }
  if (action === 'create') {
    if (!oid(item.expectedHead) || !['annotated','lightweight'].includes(item.mode as string)) {
      throw new Error('Create tag requires a verified HEAD and tag mode')
    }
    result.expectedHead = item.expectedHead
    result.mode = item.mode as TagMode
    if (result.mode === 'annotated') {
      if (typeof item.message !== 'string' || item.message.trim().length === 0 ||
        item.message.length > 1000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(item.message)) {
        throw new Error('Invalid annotated tag message')
      }
      result.message = item.message.trim()
    } else if (item.message !== undefined && item.message !== '') {
      throw new Error('Lightweight tag cannot have an annotation message')
    }
  } else {
    if (item.mode !== undefined || item.message !== undefined || item.expectedHead !== undefined) {
      throw new Error('Unexpected tag creation fields')
    }
    if (action === 'push' || action === 'delete-local' || action === 'delete-both') {
      if (!oid(item.expectedLocalOid)) throw new Error('Local tag reference is required')
      result.expectedLocalOid = item.expectedLocalOid
    } else if (item.expectedLocalOid !== undefined) {
      throw new Error('Unexpected local tag reference')
    }
    if (action === 'delete-origin' || action === 'delete-both') {
      if (!oid(item.expectedOriginOid)) throw new Error('Origin tag reference is required')
      result.expectedOriginOid = item.expectedOriginOid
    } else if (item.expectedOriginOid !== undefined) {
      throw new Error('Unexpected origin tag reference')
    }
  }
  return result
}
