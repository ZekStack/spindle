import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute } from 'node:path'
import { GitProcessError, runGit } from './git-process'
import { validateLogin, validateRepository } from '../shared/contracts'
import { cloneCheckout, pullReadiness, syncCheckout, type SyncOperation } from './git-sync'
import { GitSafetyError } from './git-safety'
import { GIT_SAFETY_CODES, type PullReadiness } from '../shared/git-safety'
import { inspectGitCheckout } from './git-inspection'
import { validGitInspection } from '../shared/git-inspection'
import type { LocalWorkspaceStore } from './local-workspaces'
import { activeJob, validateJobId, type JobErrorCode, type JobRecord } from '../shared/jobs'
import { WorkflowMutationUncertainError, WorkflowPreflightError, type GitHubClient } from './github'
import {
  validateWorkflowControlRequest, validateStoredWorkflowControl,
  type WorkflowControlRequest
} from '../shared/workflow-controls'
import { listGitTags, mutateGitTag, TagLifecycleError } from './git-tags'
import { validateTagMutation, type GitTagsSnapshot, type TagMutationRequest } from '../shared/tags'
import {
  validateReleaseMutation, type ReleaseMutationRequest
} from '../shared/releases'
import {
  validateDispatchRequest, type WorkflowDispatchRequest
} from '../shared/release-strategies'
import type { ReleaseStrategyStore } from './release-strategies'
import { validateWorkflowId } from '../shared/release-strategies'
import type { ReleaseProgressTarget, ReleaseProgressSnapshot } from '../shared/release-progress'

type Inspector = Pick<GitHubClient, 'repository' | 'releases' | 'workflowRuns'> &
  Partial<Pick<GitHubClient, 'mutateRelease' | 'dispatchReleaseWorkflow' | 'releaseProgress' | 'mutateWorkflowControl'>>
type Listener = (jobs: JobRecord[]) => void
const isLocal = (kind: JobRecord['kind']): boolean =>
  kind !== 'repository-inspection' && kind !== 'github-release' &&
  kind !== 'github-workflow-dispatch' && kind !== 'github-workflow-control'
const MAX_HISTORY = 100
const MAX_RUNNING = 2
const DEADLINE_MS = 45_000

function copy(job: JobRecord): JobRecord {
  return { ...job, output: [...job.output],
    ...(job.tagOperation ? { tagOperation: { ...job.tagOperation } } : {}),
    ...(job.releaseOperation ? { releaseOperation: { ...job.releaseOperation } } : {}),
    ...(job.dispatchOperation ? { dispatchOperation: { ...job.dispatchOperation } } : {}),
    ...(job.workflowControl ? { workflowControl: { ...job.workflowControl } } : {}),
    ...(job.inspection ? { inspection: { ...job.inspection,
      localTags: { ...job.inspection.localTags, names: [...job.inspection.localTags.names] },
      remoteTags: { ...job.inspection.remoteTags, names: [...job.inspection.remoteTags.names] }
    } } : {}) }
}
function codeFor(error: unknown): JobErrorCode {
  const message = error instanceof Error ? error.message.toLowerCase() : ''
  if (message.includes('rate limit')) return 'rate-limit'
  if (message.includes('authentication') || message.includes('sign in')) return 'auth'
  if (message.includes('denied') || message.includes('permission')) return 'forbidden'
  if (message.includes('not found') || message.includes('inaccessible')) return 'not-found'
  if (message.includes('network') || message.includes('connection')) return 'network'
  if (message.includes('timeout') || message.includes('timed out')) return 'timeout'
  return 'unknown'
}
function validStoredTagOperation(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (Object.hasOwn(record, 'message')) return false
  try {
    // Annotated messages are only retained in volatile main-process memory.
    validateTagMutation(record.action === 'create' && record.mode === 'annotated'
      ? { ...record, message: 'message omitted from history' } : record)
    return true
  } catch { return false }
}
function validStoredReleaseOperation(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const data = value as Record<string, unknown>
  if (Object.hasOwn(data, 'name') || Object.hasOwn(data, 'body')) return false
  try {
    validateReleaseMutation(data.action === 'create-draft' || data.action === 'edit-notes'
      ? { ...data, name: 'omitted', body: '' } : data)
    return true
  } catch { return false }
}
function validStoredDispatch(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.hasOwn(value, 'inputs')) return false
  try { validateDispatchRequest({ ...value, inputs: {} }); return true }
  catch { return false }
}
function validHistory(raw: unknown): raw is JobRecord[] {
  return Array.isArray(raw) && raw.length <= MAX_HISTORY && raw.every((job) =>
    job && typeof job === 'object' && typeof job.id === 'string' &&
    typeof job.repository === 'string' && job.repository.length <= 220 &&
    (job.kind === 'repository-inspection' || job.kind === 'github-release' ||
      job.kind === 'github-workflow-dispatch' || job.kind === 'github-workflow-control' ||
      (['local-git-inspection', 'local-git-clone', 'local-git-fetch', 'local-git-pull', 'local-git-tag'].includes(job.kind) &&
        typeof job.location === 'string' &&
        job.location.length > 0 && job.location.length <= 2048 &&
        isAbsolute(job.location) && !job.location.includes('\0'))) &&
    job.action === (job.kind === 'github-workflow-control' ? 'workflow-control' :
      job.kind === 'github-workflow-dispatch' ? 'dispatch' : job.kind === 'github-release' ? 'release' : job.kind === 'local-git-tag' ? 'tag' : job.kind === 'local-git-clone' ? 'clone'
      : job.kind === 'local-git-fetch' ? 'fetch'
        : job.kind === 'local-git-pull' ? 'pull' : 'inspect') &&
    ['queued', 'running', 'completed', 'partial', 'failed', 'cancelled', 'interrupted'].includes(job.phase) &&
    typeof job.requestedAt === 'string' && job.requestedAt.length <= 40 &&
    (job.startedAt === null || typeof job.startedAt === 'string') &&
    (job.finishedAt === null || typeof job.finishedAt === 'string') &&
    typeof job.progress === 'number' && job.progress >= 0 && job.progress <= 100 &&
    Array.isArray(job.output) && job.output.length <= 24 &&
    job.output.every((line: unknown) => typeof line === 'string' && line.length <= 160) &&
    (job.errorCode === null || ['auth', 'forbidden', 'not-found', 'rate-limit',
      'network', 'timeout', 'interrupted', 'git-unavailable', 'git-failed',
      'output-limit', 'unknown', 'tag-stale', 'tag-exists', 'tag-missing', 'tag-partial', 'release-stale', 'release-uncertain', 'dispatch-uncertain',
      'workflow-stale', 'workflow-uncertain', ...GIT_SAFETY_CODES].includes(job.errorCode)) &&
    (job.retryable === undefined || typeof job.retryable === 'boolean') &&
    (job.linkedRepository === undefined ||
      (job.kind === 'local-git-inspection' && typeof job.linkedRepository === 'string' &&
       /^[a-zA-Z0-9-]{1,39}\/[a-zA-Z0-9_.-]{1,100}$/.test(job.linkedRepository))) &&
    (job.inspection === undefined ||
      (job.kind === 'local-git-inspection' && validGitInspection(job.inspection))) &&
    (job.kind === 'local-git-tag'
      ? validStoredTagOperation(job.tagOperation) && typeof job.tagRemoteDeleted === 'boolean' &&
        (job.releaseWorkflowId === undefined || (job.tagOperation?.action === 'push' &&
          Number.isSafeInteger(job.releaseWorkflowId) && job.releaseWorkflowId > 0))
      : job.tagOperation === undefined && job.tagRemoteDeleted === undefined &&
        job.releaseWorkflowId === undefined) &&
    (job.kind === 'github-release' ? validStoredReleaseOperation(job.releaseOperation)
      : job.releaseOperation === undefined) &&
    (job.kind === 'github-workflow-dispatch'
      ? validStoredDispatch(job.dispatchOperation) : job.dispatchOperation === undefined) &&
    (job.kind === 'github-workflow-control'
      ? validateStoredWorkflowControl(job.workflowControl)
      : job.workflowControl === undefined))
}

/**
 * App-lifetime activity registry. Main owns all work and writes only fixed,
 * sanitized progress messages; secrets and HTTP response bodies are excluded.
 * Local Git inspection uses a bounded child process, with serial execution
 * and kill-on-cancel. Git output is summarized, never persisted raw.
 */
export class JobManager {
  private history: JobRecord[] = []
  private controllers = new Map<string, AbortController>()
  private listeners = new Set<Listener>()
  private healthy = true
  private scheduled = false
  private readonly pendingTagMessages = new Map<string, string>()
  private readonly pendingReleaseContent = new Map<string, { name?: string; body?: string; assetPath?: string }>()
  private readonly pendingDispatchInputs = new Map<string, Record<string, string>>()
  private readonly pendingWorkflowInputs = new Map<string, Record<string, string>>()

  constructor(private readonly file: string, private readonly github: Inspector,
    private readonly local?: LocalWorkspaceStore,
    private readonly releaseStrategies?: ReleaseStrategyStore) {
    if (!existsSync(file)) return
    try {
      if (statSync(file).size > 512_000) throw new Error('Oversized activity history')
      const stored: unknown = JSON.parse(readFileSync(file, 'utf8'))
      if (!validHistory(stored)) throw new Error('Invalid activity history')
      this.history = stored.map(copy)
      let changed = false
      for (const job of this.history) {
        if (!activeJob(job.phase)) continue
        job.phase = (job.kind === 'local-git-tag' && job.tagRemoteDeleted) ||
          ((job.kind === 'github-release' || job.kind === 'github-workflow-dispatch' ||
            job.kind === 'github-workflow-control') && job.startedAt !== null) ? 'partial' : 'interrupted'
        job.finishedAt = new Date().toISOString()
        job.errorCode = job.kind === 'local-git-tag' ? 'tag-partial' :
          job.kind === 'github-release' ? 'release-uncertain' :
            job.kind === 'github-workflow-dispatch' ? 'dispatch-uncertain' :
              job.kind === 'github-workflow-control' ? 'workflow-uncertain' : 'interrupted'
        job.retryable = job.kind !== 'local-git-clone' && job.kind !== 'local-git-tag' && job.kind !== 'github-release' && job.kind !== 'github-workflow-dispatch' && job.kind !== 'github-workflow-control'
        job.output.push(job.kind === 'github-workflow-control'
          ? 'Workflow action interrupted. Inspect the live run before another action.'
          : job.kind === 'github-workflow-dispatch'
          ? 'Interrupted workflow dispatch. Check Actions before dispatching again.'
          : job.kind === 'github-release'
          ? 'Release action interrupted; verify live GitHub state before another action.'
          : job.kind === 'local-git-tag'
          ? 'Interrupted tag operation; refresh local and origin tags before retrying.'
          : 'Interrupted by application restart.')
        changed = true
      }
      if (changed) this.persist()
    } catch {
      // Never overwrite a damaged history; leave other app functions usable.
      this.healthy = false
      this.history = []
    }
  }

  list(): JobRecord[] {
    if (!this.healthy) throw new Error('Activity history is unreadable. Back up or repair the history file.')
    return this.history.map(copy)
  }
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  inspect(ownerValue: string, nameValue: string): JobRecord {
    this.list()
    const owner = validateLogin(ownerValue)
    const name = validateRepository(nameValue)
    const repository = `${owner}/${name}`
    const previous = this.history.find((item) =>
      activeJob(item.phase) && item.repository.toLowerCase() === repository.toLowerCase())
    if (previous) return copy(previous)
    if (this.history.filter((item) => activeJob(item.phase)).length >= 20) {
      throw new Error('Activity queue is full')
    }
    const record: JobRecord = {
      id: randomUUID(), kind: 'repository-inspection', repository, action: 'inspect',
      requestedAt: new Date().toISOString(), startedAt: null, finishedAt: null,
      phase: 'queued', progress: 0, output: ['Repository inspection queued.'], errorCode: null,
      retryable: false
    }
    this.history.unshift(record)
    this.history = this.history.slice(0, MAX_HISTORY)
    this.publish()
    this.schedule()
    return copy(record)
  }

  /** Only the native directory picker may supply a new local path. */
  inspectLocal(pickedPath: string, linkedRepository?: string): JobRecord {
    this.list()
    if (typeof pickedPath !== 'string' || pickedPath.length > 2048) {
      throw new Error('Invalid local folder')
    }
    const location = realpathSync.native(pickedPath)
    if (!isAbsolute(location) || location.length > 2048 ||
        !statSync(location).isDirectory()) throw new Error('Invalid local folder')
    const existing = this.history.find((job) => job.kind === 'local-git-inspection' &&
      activeJob(job.phase) && job.location === location &&
      job.linkedRepository === linkedRepository)
    if (existing) return copy(existing)
    if (this.history.filter((item) => activeJob(item.phase)).length >= 20) {
      throw new Error('Activity queue is full')
    }
    const label = basename(location).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 100) || 'Local checkout'
    const record: JobRecord = {
      id: randomUUID(), kind: 'local-git-inspection', repository: linkedRepository ?? label,
      location, ...(linkedRepository ? { linkedRepository } : {}), action: 'inspect',
      requestedAt: new Date().toISOString(), startedAt: null, finishedAt: null,
      phase: 'queued', progress: 0, output: ['Local Git inspection queued.'], errorCode: null,
      retryable: false
    }
    this.history.unshift(record)
    this.history = this.history.slice(0, MAX_HISTORY)
    this.publish()
    this.schedule()
    return copy(record)
  }

  /** Inspect a saved association; do not accept a renderer-provided location. */
  inspectLinked(ownerValue: string, nameValue: string): JobRecord {
    const repository = `${validateLogin(ownerValue)}/${validateRepository(nameValue)}`
    if (!this.local) throw new Error('Local workspace storage is not configured')
    return this.inspectLocal(this.local.pathFor(repository), repository)
  }

  /** Retry a previously user-selected directory, never a renderer-supplied path. */
  retryLocal(rawId: string): JobRecord {
    const id = validateJobId(rawId)
    const previous = this.history.find((job) => job.id === id)
    if (previous?.kind !== 'local-git-inspection' || !previous.location) {
      throw new Error('Local inspection not found')
    }
    if (previous.linkedRepository) {
      const [owner, name] = previous.linkedRepository.split('/')
      return this.inspectLinked(owner, name)
    }
    return this.inspectLocal(previous.location)
  }

  /** Create a Git operation only against paths retained by the native-picker store. */
  private enqueueSync(repository: string, kind: 'local-git-clone' | 'local-git-fetch' | 'local-git-pull',
    location: string): JobRecord {
    this.list()
    if (this.history.some((item) => activeJob(item.phase) &&
      isLocal(item.kind) && item.repository.toLowerCase() === repository.toLowerCase())) {
      throw new Error('A local Git operation is already running for this repository')
    }
    if (this.history.filter((item) => activeJob(item.phase)).length >= 20) {
      throw new Error('Activity queue is full')
    }
    const action = kind === 'local-git-clone' ? 'clone' : kind === 'local-git-fetch' ? 'fetch' : 'pull'
    const record: JobRecord = {
      id: randomUUID(), kind, repository, location, action,
      requestedAt: new Date().toISOString(), startedAt: null, finishedAt: null,
      phase: 'queued', progress: 0, output: [`Git ${action} queued.`],
      errorCode: null, retryable: false
    }
    this.history.unshift(record)
    this.history = this.history.slice(0, MAX_HISTORY)
    this.publish()
    this.schedule()
    return copy(record)
  }

  clone(ownerValue: string, nameValue: string, savedRoot: string): JobRecord {
    const repository = `${validateLogin(ownerValue)}/${validateRepository(nameValue)}`
    if (!this.local) throw new Error('Local workspace storage is not configured')
    const destination = this.local.cloneDestination(repository, savedRoot)
    return this.enqueueSync(repository, 'local-git-clone', destination)
  }

  sync(ownerValue: string, nameValue: string, operation: SyncOperation): JobRecord {
    const repository = `${validateLogin(ownerValue)}/${validateRepository(nameValue)}`
    if (operation !== 'fetch' && operation !== 'pull') throw new Error('Invalid Git action')
    if (!this.local) throw new Error('Local workspace storage is not configured')
    return this.enqueueSync(repository, operation === 'fetch' ? 'local-git-fetch' : 'local-git-pull',
      this.local.pathFor(repository))
  }

  /** Live tag state is advisory and never authorizes a later remote mutation. */
  async tags(ownerValue: string, nameValue: string): Promise<GitTagsSnapshot> {
    this.list()
    const repository = `${validateLogin(ownerValue)}/${validateRepository(nameValue)}`
    if (!this.local) throw new Error('Local workspace storage is not configured')
    if (this.history.some(item => activeJob(item.phase) && isLocal(item.kind) &&
      item.repository.toLowerCase() === repository.toLowerCase())) {
      throw new Error('Wait for the current local Git operation before refreshing tags')
    }
    return listGitTags(this.local, repository, AbortSignal.timeout(25_000))
  }

  /** The annotation text is never added to history or streamed to the UI. */
  mutateTag(ownerValue: string, nameValue: string, raw: TagMutationRequest,
    releaseWorkflowId?: number): JobRecord {
    this.list()
    const repository = `${validateLogin(ownerValue)}/${validateRepository(nameValue)}`
    if (!this.local) throw new Error('Local workspace storage is not configured')
    const request = validateTagMutation(raw)
    if (releaseWorkflowId !== undefined) {
      validateWorkflowId(releaseWorkflowId)
      if (request.action !== 'push') throw new Error('Only tag pushes can start release workflows')
      const config = this.releaseStrategies?.get(repository)
      if (config?.kind !== 'tag-push' || config.workflowId !== releaseWorkflowId) {
        throw new Error('Release strategy changed; refresh before pushing')
      }
    }
    if (this.history.some(item => activeJob(item.phase) &&
      (isLocal(item.kind) || item.kind === 'github-release' ||
        item.kind === 'github-workflow-dispatch') &&
      item.repository.toLowerCase() === repository.toLowerCase())) {
      throw new Error('A local Git operation is already running for this repository')
    }
    if (this.history.filter(item => activeJob(item.phase)).length >= 20) {
      throw new Error('Activity queue is full')
    }
    const { message, ...operation } = request
    const record: JobRecord = {
      id: randomUUID(), kind: 'local-git-tag', action: 'tag', repository,
      location: this.local.pathFor(repository), tagOperation: operation, tagRemoteDeleted: false,
      ...(releaseWorkflowId === undefined ? {} : { releaseWorkflowId }),
      requestedAt: new Date().toISOString(), startedAt: null, finishedAt: null,
      phase: 'queued', progress: 0, output: ['Tag operation queued.'],
      errorCode: null, retryable: false
    }
    if (message) this.pendingTagMessages.set(record.id, message)
    this.history.unshift(record)
    this.history = this.history.slice(0, MAX_HISTORY)
    this.publish()
    this.schedule()
    return copy(record)
  }

  /** Read-only evidence for an existing Activity attempt, including after restart. */
  async releaseProgress(rawId: string): Promise<ReleaseProgressSnapshot> {
    this.list()
    const id = validateJobId(rawId)
    const job = this.history.find(entry => entry.id === id)
    if (!job) throw new Error('Release Activity entry not found')
    if (!this.github.releaseProgress) throw new Error('Release progress inspection unavailable')
    const tagPush = job.kind === 'local-git-tag' && job.tagOperation?.action === 'push'
    if (!tagPush && job.kind !== 'github-workflow-dispatch' && job.kind !== 'github-release') {
      throw new Error('Activity entry is not a release attempt')
    }
    const target: ReleaseProgressTarget = {
      jobId: job.id,
      kind: tagPush ? 'tag-push' : job.kind === 'github-workflow-dispatch' ? 'dispatch' : 'api',
      releaseAction: job.kind === 'github-release' ? job.releaseOperation?.action ?? null : null,
      tagName: tagPush ? job.tagOperation!.tag : job.kind === 'github-workflow-dispatch'
        ? job.dispatchOperation!.tagName : job.releaseOperation!.tagName,
      expectedTagOid: tagPush ? job.tagOperation!.expectedLocalOid ?? null :
        job.kind === 'github-workflow-dispatch'
          ? job.dispatchOperation!.expectedTagOid : job.releaseOperation!.expectedTagOid,
      workflowId: tagPush ? job.releaseWorkflowId ?? null :
        job.kind === 'github-workflow-dispatch' ? job.dispatchOperation!.workflowId : null,
      dispatchRef: job.kind === 'github-workflow-dispatch' ? job.dispatchOperation!.ref : null,
      startedAt: job.startedAt ?? job.requestedAt, phase: job.phase
    }
    const [owner, name] = job.repository.split('/')
    return this.github.releaseProgress(owner, name, target, AbortSignal.timeout(30_000))
  }

  /** Queue remote release mutation without writing notes, title or chosen file path to history. */
  mutateRelease(ownerValue: string, nameValue: string, input: ReleaseMutationRequest,
    pickedAssetPath?: string): JobRecord {
    this.list()
    const repository = `${validateLogin(ownerValue)}/${validateRepository(nameValue)}`
    const request = validateReleaseMutation(input)
    if (request.action === 'upload-asset' && !pickedAssetPath) {
      throw new Error('Choose a file using the native picker')
    }
    if (request.action !== 'upload-asset' && pickedAssetPath) throw new Error('Unexpected file')
    if (this.history.some(item => activeJob(item.phase) &&
      (item.kind === 'github-release' || item.kind === 'github-workflow-dispatch' ||
        item.kind === 'local-git-tag') &&
      item.repository.toLowerCase() === repository.toLowerCase())) {
      throw new Error('A release action is already running for this repository')
    }
    if (this.history.filter(item => activeJob(item.phase)).length >= 20) {
      throw new Error('Activity queue is full')
    }
    const { name, body, ...safe } = request
    const record: JobRecord = {
      id: randomUUID(), kind: 'github-release', action: 'release',
      repository, releaseOperation: safe,
      requestedAt: new Date().toISOString(), startedAt: null, finishedAt: null,
      phase: 'queued', progress: 0, output: ['GitHub Release action queued.'],
      errorCode: null, retryable: false
    }
    this.pendingReleaseContent.set(record.id, { name, body, assetPath: pickedAssetPath })
    this.history.unshift(record)
    this.history = this.history.slice(0, MAX_HISTORY)
    this.publish()
    this.schedule()
    return copy(record)
  }

  /** Dispatch inputs stay in volatile main memory, and never enter Activity history. */
  dispatchRelease(ownerValue: string, nameValue: string, raw: WorkflowDispatchRequest): JobRecord {
    this.list()
    const repository = `${validateLogin(ownerValue)}/${validateRepository(nameValue)}`
    const input = validateDispatchRequest(raw)
    if (!this.releaseStrategies) throw new Error('Release strategies are unavailable')
    const configured = this.releaseStrategies.get(repository)
    if (configured.kind !== 'dispatch' || configured.workflowId !== input.workflowId ||
        configured.ref !== input.ref) throw new Error('Release strategy changed; refresh configuration')
    if (this.history.some(item => activeJob(item.phase) &&
        (item.kind === 'github-workflow-dispatch' || item.kind === 'github-release' ||
          item.kind === 'local-git-tag') &&
        item.repository.toLowerCase() === repository.toLowerCase())) {
      throw new Error('A remote release operation is already running for this repository')
    }
    // GitHub dispatch returns no run ID. A completed/uncertain submission
    // cannot safely be retried on the same workflow/ref/tag immediately.
    // The observation window is finite; no other mutation is triggered here.
    if (this.history.some(item => item.kind === 'github-workflow-dispatch' &&
      item.repository.toLowerCase() === repository.toLowerCase() &&
      (item.phase === 'completed' || item.phase === 'partial') &&
      item.dispatchOperation?.workflowId === input.workflowId &&
      item.dispatchOperation?.tagName === input.tagName &&
      item.dispatchOperation?.ref === input.ref &&
      Date.now() - Date.parse(item.requestedAt) < 10 * 60_000)) {
      throw new Error('Recent dispatch may already have started this workflow. Inspect GitHub Actions before another attempt.')
    }
    if (this.history.filter(item => activeJob(item.phase)).length >= 20) {
      throw new Error('Activity queue is full')
    }
    const { inputs, ...safe } = input
    const record: JobRecord = {
      id: randomUUID(), kind: 'github-workflow-dispatch', repository, action: 'dispatch',
      dispatchOperation: safe,
      requestedAt: new Date().toISOString(), startedAt: null, finishedAt: null,
      phase: 'queued', progress: 0, output: ['Workflow dispatch queued.'],
      errorCode: null, retryable: false
    }
    this.pendingDispatchInputs.set(record.id, inputs)
    this.history.unshift(record)
    this.history = this.history.slice(0, MAX_HISTORY)
    this.publish()
    this.schedule()
    return copy(record)
  }

  /** Advises the renderer, never authorizes a future write operation. */
  async previewPull(ownerValue: string, nameValue: string): Promise<PullReadiness> {
    this.list()
    const repository = `${validateLogin(ownerValue)}/${validateRepository(nameValue)}`
    if (!this.local) throw new Error('Local workspace storage is not configured')
    if (this.history.some((item) => activeJob(item.phase) && isLocal(item.kind) &&
      item.repository.toLowerCase() === repository.toLowerCase())) {
      return { ready: false, reason: 'operation-in-progress', branch: null,
        staged: 0, unstaged: 0, untracked: 0, conflicted: 0,
        ahead: null, behind: null }
    }
    return pullReadiness(this.local, repository, AbortSignal.timeout(15_000))
  }

  cancel(rawId: string): JobRecord {
    const id = validateJobId(rawId)
    const job = this.history.find((item) => item.id === id)
    if (!job) throw new Error('Job not found')
    if (!activeJob(job.phase)) return copy(job)
    this.controllers.get(id)?.abort()
    this.pendingTagMessages.delete(id)
    this.pendingReleaseContent.delete(id)
    this.pendingDispatchInputs.delete(id)
    if (job.kind === 'github-workflow-dispatch' && job.phase === 'running') {
      this.finish(job, 'partial', 'dispatch-uncertain',
        'Dispatch interrupted. Inspect Actions and Releases before retrying.')
    } else if (job.kind === 'github-release' && job.phase === 'running') {
      this.finish(job, 'partial', 'release-uncertain',
        'Release request interrupted; refresh GitHub before retrying.')
    } else if (job.kind === 'local-git-tag' && job.phase === 'running') {
      this.finish(job, 'partial', 'tag-partial',
        'Tag operation interrupted. Refresh both locations; a remote mutation may have completed.')
    } else {
      this.finish(job, 'cancelled', null, 'Cancelled by user.')
    }
    this.schedule()
    return copy(job)
  }

  private schedule(): void {
    if (this.scheduled) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      while (this.controllers.size < MAX_RUNNING) {
        // Keep local child processes serialized, including future write jobs.
        // GitHub API inspections still use spare slots concurrently.
        const localRunning = [...this.controllers.keys()].some((id) =>
          this.history.some((job) => job.id === id && isLocal(job.kind)))
        const next = this.history.find((job) => job.phase === 'queued' &&
          (!isLocal(job.kind) || !localRunning))
        if (!next) break
        void this.run(next)
      }
    })
  }

  private async run(job: JobRecord): Promise<void> {
    const [owner, name] = job.repository.split('/')
    const controller = new AbortController()
    this.controllers.set(job.id, controller)
    job.startedAt = new Date().toISOString()
    job.phase = 'running'
    this.line(job, job.kind === 'github-workflow-dispatch' ? 'Validating workflow dispatch.' : job.kind === 'github-release' ? 'Starting GitHub Release action.' : job.kind === 'local-git-inspection'
      ? 'Starting local Git inspection.' : isLocal(job.kind)
        ? `Starting Git ${job.action}.` : 'Contacting GitHub for repository inspection.', 5)
    let timedOut = false
    const watchdog = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, job.kind === 'local-git-clone' ? 600_000 : job.kind === 'github-release' || job.kind === 'github-workflow-dispatch' ? 150_000 : isLocal(job.kind) && job.kind !== 'local-git-inspection' ? 300_000 : DEADLINE_MS)
    try {
      if (job.kind === 'github-workflow-dispatch') {
        if (!job.dispatchOperation || !this.github.dispatchReleaseWorkflow || !this.releaseStrategies) {
          throw new Error('Workflow dispatch unavailable')
        }
        const config = this.releaseStrategies.get(job.repository)
        if (config.kind !== 'dispatch' || config.workflowId !== job.dispatchOperation.workflowId ||
            config.ref !== job.dispatchOperation.ref) {
          throw new Error('Release strategy changed; refresh configuration')
        }
        this.line(job, 'Verifying the remote tag and configured workflow.', 20)
        await this.github.dispatchReleaseWorkflow(owner, name, {
          ...job.dispatchOperation, inputs: this.pendingDispatchInputs.get(job.id) ?? {}
        }, controller.signal)
        if (controller.signal.aborted) return
        this.line(job, 'GitHub accepted workflow dispatch. Run completion is not yet known.', 100)
        this.finish(job, 'completed', null, 'Inspect GitHub Actions for the actual workflow run.')
      } else if (job.kind === 'github-release') {
        if (!job.releaseOperation || !this.github.mutateRelease) {
          throw new Error('Release operation unavailable')
        }
        const pending = this.pendingReleaseContent.get(job.id)
        this.line(job, 'Validating the live release and tag state.', 20)
        await this.github.mutateRelease(owner, name, {
          ...job.releaseOperation, ...(pending?.name !== undefined ? { name: pending.name } : {}),
          ...(pending?.body !== undefined ? { body: pending.body } : {})
        }, controller.signal, pending?.assetPath)
        if (controller.signal.aborted) return
        this.line(job, 'GitHub confirmed the release action.', 100)
        this.finish(job, 'completed', null, 'Refresh Releases to inspect the result.')
      } else if (job.kind === 'local-git-inspection') {
        await this.inspectWorktree(job, controller.signal)
        if (controller.signal.aborted) return
        this.finish(job, 'completed', null, 'Local Git inspection completed.')
      } else if (isLocal(job.kind)) {
        if (!this.local || !job.location) throw new Error('Local checkout unavailable')
        const report = (message: string, percent: number) => this.line(job, message, percent)
        if (job.kind === 'local-git-clone') {
          await cloneCheckout(this.local, job.repository, job.location, controller.signal, report)
        } else if (job.kind === 'local-git-tag') {
          if (!job.tagOperation) throw new Error('Missing tag operation')
          // Do not retarget a queued mutation if the user relinked the repo.
          if (this.local.pathFor(job.repository) !== job.location) {
            throw new GitSafetyError('checkout-moved',
              'Linked checkout changed since the tag job was queued.')
          }
          const message = this.pendingTagMessages.get(job.id)
          if (job.releaseWorkflowId !== undefined) {
            const config = this.releaseStrategies?.get(job.repository)
            if (config?.kind !== 'tag-push' || config.workflowId !== job.releaseWorkflowId) {
              throw new Error('Release strategy changed since tag push was queued')
            }
          }
          await mutateGitTag(this.local, job.repository,
            { ...job.tagOperation, ...(message ? { message } : {}) },
            controller.signal, report, () => {
              job.tagRemoteDeleted = true
              this.publish()
            })
        } else {
          await syncCheckout(this.local, job.repository, job.action as SyncOperation,
            controller.signal, report)
        }
        if (controller.signal.aborted) return
        this.finish(job, 'completed', null, job.kind === 'local-git-tag'
          ? 'Confirmed tag action completed. Refresh tag inventory.'
          : `Git ${job.action} completed.`)
      } else {
        await this.github.repository(owner, name, controller.signal)
        if (controller.signal.aborted) return
        this.line(job, 'Repository metadata loaded.', 33)
        const releases = await this.github.releases(owner, name, controller.signal)
        if (controller.signal.aborted) return
        this.line(job, `Releases found: ${releases.length}.`, 66)
        const workflows = await this.github.workflowRuns(owner, name, controller.signal)
        if (controller.signal.aborted) return
        this.line(job, `Recent workflow runs found: ${workflows.length}.`, 100)
        this.finish(job, 'completed', null, 'Repository inspection completed.')
      }
    } catch (error) {
      if (!activeJob(job.phase)) return
      const gitFailure = error instanceof GitProcessError
        ? error.reason === 'unavailable' ? 'git-unavailable'
          : error.reason === 'output-limit' ? 'output-limit' : 'git-failed'
        : null
      const code = timedOut ? 'timeout'
        : job.kind === 'github-release' && error instanceof Error &&
            /changed since confirmation|tag changed/i.test(error.message) ? 'release-stale'
        : error instanceof TagLifecycleError ? error.code
          : error instanceof GitSafetyError ? error.code : gitFailure ?? codeFor(error)
      // Progress can reflect useful completed steps even when a subsequent
      // GitHub or local Git request fails; never report false full success.
      const hasPartialResult = job.kind === 'repository-inspection'
        ? job.progress >= 33 : job.kind === 'local-git-inspection' && job.progress >= 60
      this.finish(job, job.kind === 'github-workflow-dispatch' ? 'partial' : job.kind === 'github-release' && timedOut
        ? 'partial' : job.kind === 'local-git-tag' && job.tagRemoteDeleted
          ? 'partial' : hasPartialResult ? 'partial' : 'failed',
        job.kind === 'github-workflow-dispatch' ? 'dispatch-uncertain' : job.kind === 'github-release' && timedOut ? 'release-uncertain'
          : job.kind === 'local-git-tag' && job.tagRemoteDeleted ? 'tag-partial' : code,
        job.kind === 'local-git-tag' && job.tagRemoteDeleted
          ? 'Origin deletion succeeded; local deletion may remain. Refresh both before continuing.'
          : job.kind === 'local-git-tag'
            ? 'Tag operation could not finish; refresh local and origin tags before retrying.'
          : job.kind === 'github-release'
            ? 'Release action was not confirmed; inspect GitHub state before retrying.'
          : job.kind === 'github-workflow-dispatch'
            ? 'Dispatch was not confirmed. Inspect Actions before retrying.'
          : timedOut ? 'Operation timed out.'
          : code === 'git-unavailable' ? 'Git executable was not found.'
            : code === 'output-limit' ? 'Git output exceeded the safe limit.'
              : isLocal(job.kind)
                ? `Local Git ${job.action} could not finish. Check the destination, origin, upstream and credentials.`
                : 'Repository inspection could not finish.')
    } finally {
      clearTimeout(watchdog)
      if (timedOut && activeJob(job.phase)) {
        const partial = job.kind === 'repository-inspection'
          ? job.progress >= 33 : job.kind === 'local-git-inspection' && job.progress >= 60
        this.finish(job, job.kind === 'github-release' || job.kind === 'github-workflow-dispatch' ? 'partial' : job.kind === 'local-git-tag' && job.tagRemoteDeleted
          ? 'partial' : partial ? 'partial' : 'failed',
          job.kind === 'github-workflow-dispatch' ? 'dispatch-uncertain' : job.kind === 'github-release' ? 'release-uncertain' : job.kind === 'local-git-tag' ? 'tag-partial' : 'timeout',
          job.kind === 'github-workflow-dispatch' ? 'Dispatch state uncertain; check Actions.' :
            job.kind === 'github-release' ? 'Release state uncertain; refresh GitHub.' :
            job.kind === 'local-git-tag' ? 'Tag state uncertain; refresh both locations.' : 'Operation timed out.')
      }
      this.controllers.delete(job.id)
      this.pendingTagMessages.delete(job.id)
      this.pendingReleaseContent.delete(job.id)
      this.pendingDispatchInputs.delete(job.id)
      this.schedule()
    }
  }

  private async inspectWorktree(job: JobRecord, signal: AbortSignal): Promise<void> {
    if (!job.location) throw new Error('Missing selected folder')
    this.line(job, 'Finding Git executable.', 10)
    await runGit(['--version'], signal)
    if (signal.aborted) return
    this.line(job, 'Finding local working tree.', 25)
    const snapshot = await inspectGitCheckout(
      job.location, signal, (message, progress) => this.line(job, message, progress),
      job.linkedRepository, this.local
    )
    if (signal.aborted) return
    // Publish only the bounded, validated snapshot; no Git stderr, filenames
    // or remote URLs are ever saved to history.
    if (!validGitInspection(snapshot)) throw new Error('Invalid Git inspection snapshot')
    job.inspection = snapshot
    this.line(job, `Branch: ${snapshot.branch ?? '(detached HEAD)'}.`, 96)
    this.line(job, `Staged: ${snapshot.staged}; modified: ${snapshot.unstaged}; untracked: ${snapshot.untracked}.`, 100)
  }

  private line(job: JobRecord, message: string, progress: number): void {
    if (job.phase !== 'running') return
    job.progress = progress
    job.output.push(message)
    job.output = job.output.slice(-24)
    this.publish()
  }
  private finish(job: JobRecord, phase: 'completed' | 'partial' | 'failed' | 'cancelled',
    errorCode: JobErrorCode | null, message: string): void {
    if (!activeJob(job.phase)) return
    job.phase = phase
    job.errorCode = errorCode
    job.retryable = job.kind !== 'local-git-clone' && job.kind !== 'github-release' && job.kind !== 'github-workflow-dispatch' &&
      (phase === 'cancelled' || errorCode === 'rate-limit' ||
        errorCode === 'network' || errorCode === 'timeout' ||
        errorCode === 'interrupted' || errorCode === 'unknown')
    job.finishedAt = new Date().toISOString()
    job.output.push(message)
    job.output = job.output.slice(-24)
    this.publish()
  }
  private publish(): void {
    this.persist()
    const snapshot = this.history.map(copy)
    for (const listener of this.listeners) listener(snapshot)
  }
  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const temp = `${this.file}.${process.pid}.${randomUUID()}.tmp`
    writeFileSync(temp, JSON.stringify(this.history), { flag: 'wx', mode: 0o600 })
    renameSync(temp, this.file)
  }
}
