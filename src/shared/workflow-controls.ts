import { validateWorkflowId, validateWorkflowRef } from './release-strategies'
import { TAG_OID_PATTERN } from './tags'
import type { WorkflowDispatchInput } from './workflow-discovery'

export type WorkflowControlAction = 'dispatch' | 'cancel' | 'rerun' | 'rerun-failed'
export type WorkflowRefType = 'branch' | 'tag'

export interface WorkflowDispatchPreview {
  workflowId: number
  workflowName: string
  ref: string
  refType: WorkflowRefType
  refOid: string
  defaultBlobSha: string
  sourceBlobSha: string
  inputs: WorkflowDispatchInput[]
  defaultBranch: string
}
export type WorkflowControlRequest =
  | {
      action: 'dispatch'
      workflowId: number
      ref: string
      refType: WorkflowRefType
      expectedRefOid: string
      expectedDefaultBlobSha: string
      expectedSourceBlobSha: string
      /** Confidential; only kept in volatile main memory. */
      inputs: Record<string, string>
    }
  | {
      action: 'cancel' | 'rerun' | 'rerun-failed'
      workflowId: number
      runId: number
      expectedHeadSha: string
      expectedAttempt: number
      expectedStatus: string
      expectedConclusion: string | null
    }
export type StoredWorkflowControl = WorkflowControlRequest extends infer T
  ? T extends { action: 'dispatch' } ? Omit<T, 'inputs'> : T
  : never

function sha(value: unknown): string {
  if (typeof value !== 'string' || !TAG_OID_PATTERN.test(value)) {
    throw new Error('Invalid expected Git object SHA')
  }
  return value
}
function numberId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error('Invalid run ID or attempt')
  }
  return value
}
function plain(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid workflow control request')
  }
  return value as Record<string, unknown>
}
function allowed(value: Record<string, unknown>, names: string[]): void {
  if (Object.keys(value).some(k => !names.includes(k))) {
    throw new Error('Unexpected workflow control fields')
  }
}
export function validateWorkflowControlRequest(raw: unknown): WorkflowControlRequest {
  const value = plain(raw)
  const workflowId = validateWorkflowId(value.workflowId)
  if (value.action === 'dispatch') {
    allowed(value, ['action','workflowId','ref','refType','expectedRefOid',
      'expectedDefaultBlobSha','expectedSourceBlobSha','inputs'])
    if (value.refType !== 'branch' && value.refType !== 'tag') {
      throw new Error('Invalid workflow ref type')
    }
    const inputs = plain(value.inputs)
    if (Object.keys(inputs).length > 10) throw new Error('Too many workflow inputs')
    const safe: Record<string, string> = Object.create(null)
    for (const [name, data] of Object.entries(inputs)) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_-]{0,99}$/.test(name) ||
        typeof data !== 'string' || data.length > 1024 ||
        /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(data)) {
        throw new Error('Invalid workflow input')
      }
      safe[name] = data
    }
    return {
      action: 'dispatch', workflowId, ref: validateWorkflowRef(value.ref),
      refType: value.refType,
      expectedRefOid: sha(value.expectedRefOid),
      expectedDefaultBlobSha: sha(value.expectedDefaultBlobSha),
      expectedSourceBlobSha: sha(value.expectedSourceBlobSha), inputs: safe
    }
  }
  if (value.action === 'cancel' || value.action === 'rerun' ||
      value.action === 'rerun-failed') {
    allowed(value, ['action','workflowId','runId','expectedHeadSha',
      'expectedAttempt','expectedStatus','expectedConclusion'])
    if (typeof value.expectedStatus !== 'string' ||
      !['queued','in_progress','waiting','pending','requested','completed'].includes(value.expectedStatus)) {
      throw new Error('Invalid expected run status')
    }
    if (value.expectedConclusion !== null && typeof value.expectedConclusion !== 'string') {
      throw new Error('Invalid expected run conclusion')
    }
    return {
      action: value.action, workflowId,
      runId: numberId(value.runId), expectedHeadSha: sha(value.expectedHeadSha),
      expectedAttempt: numberId(value.expectedAttempt),
      expectedStatus: value.expectedStatus,
      expectedConclusion: value.expectedConclusion
    }
  }
  throw new Error('Unknown workflow action')
}

export function validateStoredWorkflowControl(raw: unknown): raw is StoredWorkflowControl {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
      Object.hasOwn(raw, 'inputs')) return false
  try {
    const item = raw as Record<string, unknown>
    validateWorkflowControlRequest(item.action === 'dispatch'
      ? { ...item, inputs: {} } : item)
    return true
  } catch { return false }
}

/** Never silently convert a run mutation into an action on a newer attempt. */
export function workflowActionAllowed(
  action: WorkflowControlAction, status: string, conclusion: string | null
): boolean {
  if (action === 'cancel') {
    return ['queued','in_progress','waiting','pending','requested'].includes(status)
  }
  if (action === 'rerun') return status === 'completed'
  if (action === 'rerun-failed') return status === 'completed' &&
    ['failure','timed_out'].includes(conclusion ?? '')
  return false
}

/** Match only the workflow's declared inputs, not a guessed or hardcoded schema. */
export function validateDeclaredInputs(
  supplied: Record<string, string>, declared: WorkflowDispatchInput[]
): Record<string, string> {
  if (declared.length > 10) throw new Error('Workflow declares too many inputs')
  const keys = new Set(declared.map(item => item.name))
  if (Object.keys(supplied).some(name => !keys.has(name))) {
    throw new Error('Input not declared by the selected workflow')
  }
  for (const input of declared) {
    const value = supplied[input.name]
    if (input.required && (value === undefined || value === '')) {
      throw new Error('Required workflow input is missing')
    }
    if (value === undefined || value === '') continue
    if (input.type === 'boolean' && !['true','false'].includes(value)) {
      throw new Error('Invalid boolean workflow input')
    }
    if (input.type === 'number' && (!Number.isFinite(Number(value)) ||
      value.trim() === '')) throw new Error('Invalid number workflow input')
    if (input.type === 'choice' && input.options.length &&
      !input.options.includes(value)) throw new Error('Invalid choice workflow input')
    if (!['string','choice','number','boolean','environment'].includes(input.type)) {
      throw new Error('Unknown workflow input type')
    }
  }
  return supplied
}
