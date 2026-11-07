import { TAG_OID_PATTERN, validateTagName } from './tags'

/** Release data returned from GitHub, never a local Git tag or Actions run. */
export interface ReleaseAsset {
  id: number
  name: string
  size: number
  state: string
}
export interface ReleaseDetails {
  id: number
  tagName: string
  name: string | null
  body: string
  draft: boolean
  prerelease: boolean
  immutable: boolean
  publishedAt: string | null
  updatedAt: string
  htmlUrl: string
  assets: ReleaseAsset[]
  /** Exact Git object ref and peeled commit. Null means tag verification unavailable. */
  tagOid: string | null
  commitSha: string | null
}
export interface ReleaseTagPreview {
  name: string
  tagOid: string
  commitSha: string
}

export type ReleaseAction = 'create-draft' | 'edit-notes' | 'publish' |
  'upload-asset' | 'delete-release'
export interface ReleaseMutationRequest {
  action: ReleaseAction
  tagName: string
  /** Confirmed remote tag object SHA, not a branch or local HEAD. */
  expectedTagOid: string | null
  releaseId?: number
  /** Prevent stale edits and actions on release content changed after preview. */
  expectedUpdatedAt?: string
  name?: string
  body?: string
  prerelease?: boolean
}
export type SafeReleaseMutation = Omit<ReleaseMutationRequest, 'name' | 'body'>

const validId = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0

/** Strict IPC whitelist. Free-form notes remain transient and never enter Activity history. */
export function validateReleaseMutation(value: unknown): ReleaseMutationRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid release action')
  }
  const input = value as Record<string, unknown>
  const action = input.action
  if (!['create-draft', 'edit-notes', 'publish', 'upload-asset', 'delete-release'].includes(action as string)) {
    throw new Error('Invalid release action')
  }
  const tagName = validateTagName(input.tagName)
  if (input.expectedTagOid !== null &&
      (typeof input.expectedTagOid !== 'string' ||
       !TAG_OID_PATTERN.test(input.expectedTagOid))) {
    throw new Error('Invalid expected release tag ref')
  }
  const result: ReleaseMutationRequest = {
    action: action as ReleaseAction, tagName, expectedTagOid: input.expectedTagOid as string | null
  }
  if (action === 'create-draft') {
    if (!result.expectedTagOid || input.releaseId !== undefined ||
        input.expectedUpdatedAt !== undefined || input.prerelease !== undefined) {
      throw new Error('Creating a draft requires an existing verified tag')
    }
  } else {
    if (!validId(input.releaseId) || typeof input.expectedUpdatedAt !== 'string' ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(input.expectedUpdatedAt)) {
      throw new Error('Release confirmation is stale or incomplete')
    }
    result.releaseId = input.releaseId
    result.expectedUpdatedAt = input.expectedUpdatedAt
  }
  if (action === 'create-draft' || action === 'edit-notes') {
    if (typeof input.name !== 'string' || input.name.trim().length < 1 ||
        input.name.length > 150 || /[\x00-\x1f\x7f]/.test(input.name) ||
        typeof input.body !== 'string' || input.body.length > 64_000 ||
        /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(input.body)) {
      throw new Error('Invalid release title or notes')
    }
    result.name = input.name.trim()
    result.body = input.body
  } else if (input.name !== undefined || input.body !== undefined) {
    throw new Error('Unexpected release content')
  }
  if (action === 'publish') {
    if (typeof input.prerelease !== 'boolean') throw new Error('Select stable or prerelease')
    result.prerelease = input.prerelease
  } else if (input.prerelease !== undefined) {
    throw new Error('Unexpected release publication mode')
  }
  return result
}
