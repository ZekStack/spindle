import type { PageResult } from './contracts'
import type { WorkflowChoice } from './release-strategies'

export interface WorkflowCatalogPage extends PageResult<WorkflowChoice> {
  page: number
  pageSize: number
}

export type WorkflowSourceState = 'parsed' | 'unavailable' | 'too-large' | 'invalid'
export interface WorkflowTrigger {
  event: string
  filters: string[]
  /** Expressions/complex selectors cannot be reliably resolved statically. */
  complex: boolean
}
export interface WorkflowDispatchInput {
  name: string
  description: string
  required: boolean
  type: string
  options: string[]
}
export interface DeclaredPermissions {
  mode: 'unspecified' | 'read-all' | 'write-all' | 'explicit' | 'dynamic'
  entries: Array<{ scope: string; access: string }>
}
export interface WorkflowJobPermissions {
  job: string
  permissions: DeclaredPermissions
}
export interface WorkflowSource {
  workflow: WorkflowChoice
  branch: string
  commitSha: string | null
  sourceState: WorkflowSourceState
  triggers: WorkflowTrigger[]
  dispatchInputs: WorkflowDispatchInput[]
  permissions: DeclaredPermissions
  jobPermissions: WorkflowJobPermissions[]
}

/** Detailed run properties are read-only; status is not inferred from a Release. */
export interface WorkflowRunSummary {
  id: number
  workflowId: number
  name: string
  number: number
  attempt: number
  event: string
  status: string
  conclusion: string | null
  headBranch: string | null
  headSha: string
  createdAt: string
  updatedAt: string
  htmlUrl: string
}
export interface WorkflowRunsFilter {
  page: number
  branch?: string
  event?: string
  status?: string
}
export interface WorkflowRunsPage extends PageResult<WorkflowRunSummary> {
  page: number
  workflowId: number
}

/** A finite, conservative API whitelist; never allow arbitrary query strings over IPC. */
export function validateWorkflowPage(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 1000) {
    throw new Error('Invalid workflow page')
  }
  return value as number
}

export function validateRunsFilter(value: unknown): WorkflowRunsFilter {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid workflow run filters')
  }
  const v = value as Record<string, unknown>
  if (Object.keys(v).some(k => !['page', 'branch', 'event', 'status'].includes(k))) {
    throw new Error('Unexpected workflow run filter')
  }
  const result: WorkflowRunsFilter = { page: validateWorkflowPage(v.page) }
  if (v.branch !== undefined && v.branch !== '') {
    if (typeof v.branch !== 'string' || v.branch.length > 120 ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(v.branch) ||
      v.branch.includes('..') || v.branch.includes('//') || v.branch.endsWith('/') ||
      v.branch.includes('@{')) throw new Error('Invalid run branch filter')
    result.branch = v.branch
  }
  if (v.event !== undefined && v.event !== '') {
    if (typeof v.event !== 'string' || !/^[a-z_]{1,40}$/.test(v.event)) {
      throw new Error('Invalid workflow event filter')
    }
    result.event = v.event
  }
  if (v.status !== undefined && v.status !== '') {
    const allowed = ['queued', 'in_progress', 'completed', 'waiting', 'requested',
      'pending', 'success', 'failure', 'cancelled', 'neutral', 'skipped',
      'timed_out', 'action_required', 'stale']
    if (!allowed.includes(v.status as string)) throw new Error('Invalid workflow run status')
    result.status = v.status as string
  }
  return result
}
