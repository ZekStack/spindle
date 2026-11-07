import { load } from 'js-yaml'
import type {
  DeclaredPermissions, WorkflowDispatchInput, WorkflowJobPermissions,
  WorkflowTrigger
} from '../shared/workflow-discovery'

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
const label = (value: unknown, max = 160): string =>
  typeof value === 'string' ? value.slice(0, max) : ''
const MAX_SOURCE_BYTES = 128 * 1024

export interface WorkflowDefinition {
  triggers: WorkflowTrigger[]
  dispatchInputs: WorkflowDispatchInput[]
  permissions: DeclaredPermissions
  jobPermissions: WorkflowJobPermissions[]
}
function declaredPermissions(value: unknown): DeclaredPermissions {
  if (value === 'read-all' || value === 'write-all') {
    return { mode: value, entries: [] }
  }
  const data = record(value)
  if (!data) return {
    mode: value === undefined ? 'unspecified' : 'dynamic', entries: []
  }
  const entries = Object.entries(data).slice(0, 40).map(([scope, access]) => ({
    scope: scope.slice(0, 70),
    access: typeof access === 'string' && ['read', 'write', 'none'].includes(access)
      ? access : 'dynamic'
  }))
  return { mode: 'explicit', entries }
}

/** Parse bounded, untrusted workflow metadata without expanding expressions. */
export function parseWorkflowDefinition(source: string): WorkflowDefinition {
  if (Buffer.byteLength(source, 'utf8') > MAX_SOURCE_BYTES) {
    throw new Error('Workflow source too large')
  }
  const obj = record(load(source))
  if (!obj) throw new Error('Invalid workflow source')
  const triggerValue = obj.on
  const triggered: Array<[string, unknown]> =
    typeof triggerValue === 'string' ? [[triggerValue, null]]
      : Array.isArray(triggerValue) ? triggerValue.slice(0, 32).map(value =>
        [label(value, 80), null] as [string, unknown])
        : Object.entries(record(triggerValue) ?? {}).slice(0, 32)
  const triggers: WorkflowTrigger[] = triggered
    .filter(([name]) => /^[a-z][a-z0-9_]{0,79}$/.test(name))
    .map(([event, config]) => {
      const configRecord = record(config)
      const filters: string[] = []
      if (event === 'schedule' && Array.isArray(config)) {
        for (const schedule of config.slice(0, 12)) {
          const cron = record(schedule)?.cron
          if (typeof cron === 'string') filters.push('cron: ' + cron.slice(0, 110))
        }
        return { event, filters,
          complex: config.length > 12 || filters.length !== config.length }
      }
      let complex = false
      if (configRecord) {
        for (const [key, value] of Object.entries(configRecord).slice(0, 16)) {
          if (key === 'inputs' || key === 'secrets' || key === 'outputs') continue
          const simple = typeof value === 'string'
            ? [value] : Array.isArray(value) ? value : []
          if (!simple.length && value !== null) complex = true
          if (!simple.every(v => typeof v === 'string' || typeof v === 'number')) {
            complex = true
            continue
          }
          if (simple.length) {
            const values = simple.slice(0, 8).map(v => String(v).slice(0, 110))
            if (simple.length > values.length) complex = true
            filters.push(`${key.slice(0, 60)}: ${values.join(', ')}`)
          }
        }
        if (Object.keys(configRecord).length > 16) complex = true
      } else if (config !== null && config !== undefined) {
        complex = true
      }
      return { event, filters, complex }
    })
  const on = record(triggerValue)
  const dispatch = record(on?.workflow_dispatch)
  const definedInputs = record(dispatch?.inputs)
  const dispatchInputs: WorkflowDispatchInput[] = Object.entries(definedInputs ?? {})
    .slice(0, 10)
    .filter(([name]) => /^[a-zA-Z_][a-zA-Z0-9_-]{0,99}$/.test(name))
    .map(([name, raw]) => {
      const input = record(raw)
      return {
        name, description: label(input?.description, 280),
        required: input?.required === true,
        type: label(input?.type, 40) || 'string',
        options: Array.isArray(input?.options) ?
          input.options.filter((v): v is string => typeof v === 'string')
            .slice(0, 50).map(v => v.slice(0, 100)) : []
      }
    })
  const jobPermissions: WorkflowJobPermissions[] = []
  const jobs = record(obj.jobs)
  for (const [job, value] of Object.entries(jobs ?? {}).slice(0, 50)) {
    const jobObject = record(value)
    if (jobObject && Object.hasOwn(jobObject, 'permissions')) {
      jobPermissions.push({
        job: job.slice(0, 100),
        permissions: declaredPermissions(jobObject.permissions)
      })
    }
  }
  return {
    triggers, dispatchInputs, permissions: declaredPermissions(obj.permissions),
    jobPermissions
  }
}

/** GitHub Contents API returns base64 source plus a declared original size. */
export function decodeWorkflowContent(raw: {
  encoding: string; content: string; size: number
}): string {
  if (raw.encoding !== 'base64' || !Number.isSafeInteger(raw.size) ||
      raw.size < 0 || raw.size > MAX_SOURCE_BYTES ||
      typeof raw.content !== 'string' || raw.content.length > 200_000) {
    throw new Error('Workflow source unavailable or too large')
  }
  const encoded = raw.content.replace(/[\r\n]/g, '')
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new Error('Invalid workflow source encoding')
  }
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.length !== raw.size) throw new Error('Workflow source length mismatch')
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}
