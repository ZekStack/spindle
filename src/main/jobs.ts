import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute } from 'node:path'
import { GitProcessError, runGit } from './git-process'
import { validateLogin, validateRepository } from '../shared/contracts'
import { cloneCheckout, syncCheckout, type SyncOperation } from './git-sync'
import { inspectGitCheckout } from './git-inspection'
import { validGitInspection } from '../shared/git-inspection'
import type { LocalWorkspaceStore } from './local-workspaces'
import { activeJob, validateJobId, type JobErrorCode, type JobRecord } from '../shared/jobs'
import type { GitHubClient } from './github'

type Inspector = Pick<GitHubClient, 'repository' | 'releases' | 'workflowRuns'>
type Listener = (jobs: JobRecord[]) => void
const isLocal = (kind: JobRecord['kind']): boolean => kind !== 'repository-inspection'
const MAX_HISTORY = 100
const MAX_RUNNING = 2
const DEADLINE_MS = 45_000

function copy(job: JobRecord): JobRecord {
  return { ...job, output: [...job.output],
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
function validHistory(raw: unknown): raw is JobRecord[] {
  return Array.isArray(raw) && raw.length <= MAX_HISTORY && raw.every((job) =>
    job && typeof job === 'object' && typeof job.id === 'string' &&
    typeof job.repository === 'string' && job.repository.length <= 220 &&
    (job.kind === 'repository-inspection' ||
      (['local-git-inspection', 'local-git-clone', 'local-git-fetch', 'local-git-pull'].includes(job.kind) &&
        typeof job.location === 'string' &&
        job.location.length > 0 && job.location.length <= 2048 &&
        isAbsolute(job.location) && !job.location.includes('\0'))) &&
    job.action === (job.kind === 'local-git-clone' ? 'clone'
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
      'output-limit', 'unknown'].includes(job.errorCode)) &&
    (job.retryable === undefined || typeof job.retryable === 'boolean') &&
    (job.linkedRepository === undefined ||
      (job.kind === 'local-git-inspection' && typeof job.linkedRepository === 'string' &&
       /^[a-zA-Z0-9-]{1,39}\/[a-zA-Z0-9_.-]{1,100}$/.test(job.linkedRepository))) &&
    (job.inspection === undefined ||
      (job.kind === 'local-git-inspection' && validGitInspection(job.inspection))))
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

  constructor(private readonly file: string, private readonly github: Inspector,
    private readonly local?: LocalWorkspaceStore) {
    if (!existsSync(file)) return
    try {
      if (statSync(file).size > 512_000) throw new Error('Oversized activity history')
      const stored: unknown = JSON.parse(readFileSync(file, 'utf8'))
      if (!validHistory(stored)) throw new Error('Invalid activity history')
      this.history = stored.map(copy)
      let changed = false
      for (const job of this.history) {
        if (!activeJob(job.phase)) continue
        job.phase = 'interrupted'
        job.finishedAt = new Date().toISOString()
        job.errorCode = 'interrupted'
        job.retryable = job.kind !== 'local-git-clone'
        job.output.push('Interrupted by application restart.')
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

  cancel(rawId: string): JobRecord {
    const id = validateJobId(rawId)
    const job = this.history.find((item) => item.id === id)
    if (!job) throw new Error('Job not found')
    if (!activeJob(job.phase)) return copy(job)
    this.controllers.get(id)?.abort()
    this.finish(job, 'cancelled', null, 'Cancelled by user.')
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
    this.line(job, job.kind === 'local-git-inspection'
      ? 'Starting local Git inspection.' : isLocal(job.kind)
        ? `Starting Git ${job.action}.` : 'Contacting GitHub for repository inspection.', 5)
    let timedOut = false
    const watchdog = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, job.kind === 'local-git-clone' ? 600_000 : isLocal(job.kind) && job.kind !== 'local-git-inspection' ? 300_000 : DEADLINE_MS)
    try {
      if (job.kind === 'local-git-inspection') {
        await this.inspectWorktree(job, controller.signal)
        if (controller.signal.aborted) return
        this.finish(job, 'completed', null, 'Local Git inspection completed.')
      } else if (isLocal(job.kind)) {
        if (!this.local || !job.location) throw new Error('Local checkout unavailable')
        const report = (message: string, percent: number) => this.line(job, message, percent)
        if (job.kind === 'local-git-clone') {
          await cloneCheckout(this.local, job.repository, job.location, controller.signal, report)
        } else {
          await syncCheckout(this.local, job.repository, job.action as SyncOperation,
            controller.signal, report)
        }
        if (controller.signal.aborted) return
        this.finish(job, 'completed', null, `Git ${job.action} completed.`)
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
      const code = timedOut ? 'timeout' : gitFailure ?? codeFor(error)
      // Progress can reflect useful completed steps even when a subsequent
      // GitHub or local Git request fails; never report false full success.
      const hasPartialResult = job.kind === 'repository-inspection'
        ? job.progress >= 33 : job.kind === 'local-git-inspection' && job.progress >= 60
      this.finish(job, hasPartialResult ? 'partial' : 'failed', code,
        timedOut ? 'Operation timed out.'
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
        this.finish(job, partial ? 'partial' : 'failed', 'timeout', 'Operation timed out.')
      }
      this.controllers.delete(job.id)
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
    job.retryable = job.kind !== 'local-git-clone' &&
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
