/** Bounded, sanitized Git inspection data safe for renderer IPC and Activity history. */
export interface GitTagInventory {
  names: string[]
  total: number
}
export interface GitRemoteTags extends GitTagInventory {
  state: 'available' | 'unavailable' | 'not-requested'
}
export interface LocalGitInspection {
  inspectedAt: string
  branch: string | null
  detached: boolean
  commit: string | null
  upstream: string | null
  ahead: number | null
  behind: number | null
  staged: number
  unstaged: number
  untracked: number
  conflicted: number
  localTags: GitTagInventory
  remoteTags: GitRemoteTags
}

export const MAX_VISIBLE_TAGS = 40

/** Match the bounded output accepted from Git; never persist raw command output. */
export function validGitInspection(raw: unknown): raw is LocalGitInspection {
  if (!raw || typeof raw !== 'object') return false
  const item = raw as Record<string, unknown>
  const safeRef = (value: unknown) => value === null ||
    (typeof value === 'string' && value.length <= 128 &&
      /^[a-zA-Z0-9._/-]+$/.test(value)) || value === '(omitted)'
  const count = (value: unknown) => Number.isSafeInteger(value) &&
    (value as number) >= 0 && (value as number) <= 1_000_000
  const inventory = (value: unknown): value is GitTagInventory => {
    if (!value || typeof value !== 'object') return false
    const inv = value as Record<string, unknown>
    return count(inv.total) && Array.isArray(inv.names) &&
      inv.names.length <= MAX_VISIBLE_TAGS && inv.names.length <= (inv.total as number) &&
      inv.names.every((name: unknown) => typeof name === 'string' &&
        name.length <= 128 && /^[a-zA-Z0-9._/-]+$/.test(name))
  }
  const local = item.localTags
  const remote = item.remoteTags as Record<string, unknown> | null
  return typeof item.inspectedAt === 'string' && item.inspectedAt.length <= 40 &&
    safeRef(item.branch) && typeof item.detached === 'boolean' &&
    (item.commit === null || (typeof item.commit === 'string' &&
      /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(item.commit))) &&
    safeRef(item.upstream) && (item.ahead === null || count(item.ahead)) &&
    (item.behind === null || count(item.behind)) &&
    count(item.staged) && count(item.unstaged) &&
    count(item.untracked) && count(item.conflicted) &&
    inventory(local) && inventory(remote) &&
    ['available', 'unavailable', 'not-requested'].includes(remote.state as string) &&
    (remote.state === 'available' || (remote.total === 0 && remote.names.length === 0))
}
