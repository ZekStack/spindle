import { parseRepositoryFullName } from './contracts'
import { TAG_OID_PATTERN, validateTagName } from './tags'

/** A repository's explicit local preference. No organization- or workflow-name assumptions. */
export type ReleaseStrategy =
  | { kind: 'api' }
  | { kind: 'tag-push'; workflowId: number }
  | { kind: 'dispatch'; workflowId: number; ref: string }

export interface ReleaseStrategyEntry {
  repository: string
  strategy: ReleaseStrategy
}
export interface WorkflowChoice {
  id: number
  name: string
  path: string
  state: string
}
export interface WorkflowChoices {
  items: WorkflowChoice[]
  truncated: boolean
}
export interface WorkflowDispatchRequest {
  workflowId: number
  ref: string
  tagName: string
  expectedTagOid: string
  /** Never persist values: a workflow input may be a secret. */
  inputs: Record<string, string>
}
export type StoredDispatchRequest = Omit<WorkflowDispatchRequest, 'inputs'>

export function validateWorkflowId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error('Invalid workflow identifier')
  }
  return value
}
/** Branch or tag names: conservative ref subset; disallow Git ref injection. */
export function validateWorkflowRef(value: unknown): string {
  if (typeof value !== 'string' || value.length > 150 || value.length === 0) {
    throw new Error('Invalid workflow ref')
  }
  return validateTagName(value)
}

export function validateReleaseStrategy(value: unknown): ReleaseStrategy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid release strategy')
  }
  const data = value as Record<string, unknown>
  if (data.kind === 'api') {
    if (Object.keys(data).length !== 1) throw new Error('Unexpected API strategy fields')
    return { kind: 'api' }
  }
  if (data.kind === 'tag-push') {
    if (Object.keys(data).length !== 2) throw new Error('Unexpected tag strategy fields')
    return { kind: 'tag-push', workflowId: validateWorkflowId(data.workflowId) }
  }
  if (data.kind === 'dispatch') {
    if (Object.keys(data).length !== 3) throw new Error('Unexpected dispatch strategy fields')
    return { kind: 'dispatch', workflowId: validateWorkflowId(data.workflowId),
      ref: validateWorkflowRef(data.ref) }
  }
  throw new Error('Unknown release strategy')
}

export function validateStrategyEntry(value: unknown): ReleaseStrategyEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid repository release strategy')
  }
  const item = value as Record<string, unknown>
  const { owner, name } = parseRepositoryFullName(item.repository)
  return { repository: `${owner}/${name}`, strategy: validateReleaseStrategy(item.strategy) }
}

export function validateDispatchRequest(value: unknown): WorkflowDispatchRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid workflow dispatch')
  }
  const item = value as Record<string, unknown>
  const keys = Object.keys(item)
  if (keys.some(k => !['workflowId','ref','tagName','expectedTagOid','inputs'].includes(k))) {
    throw new Error('Unexpected workflow dispatch fields')
  }
  const workflowId = validateWorkflowId(item.workflowId)
  const ref = validateWorkflowRef(item.ref)
  const tagName = validateTagName(item.tagName)
  if (typeof item.expectedTagOid !== 'string' || !TAG_OID_PATTERN.test(item.expectedTagOid)) {
    throw new Error('Invalid confirmed tag SHA')
  }
  if (!item.inputs || typeof item.inputs !== 'object' || Array.isArray(item.inputs)) {
    throw new Error('Invalid workflow inputs')
  }
  const inputs = item.inputs as Record<string, unknown>
  if (Object.keys(inputs).length > 10) throw new Error('Too many workflow inputs')
  const safe: Record<string, string> = Object.create(null)
  for (const [key, val] of Object.entries(inputs)) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_-]{0,99}$/.test(key) ||
      typeof val !== 'string' || val.length > 1024 ||
      /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(val)) {
      throw new Error('Invalid workflow input')
    }
    safe[key] = val
  }
  return { workflowId, ref, tagName, expectedTagOid: item.expectedTagOid, inputs: safe }
}
