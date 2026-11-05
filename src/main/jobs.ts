import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute } from 'node:path'
import { GitProcessError, runGit } from './git-process'
import { validateLogin, validateRepository } from '../shared/contracts'
import { activeJob, validateJobId, type JobErrorCode, type JobRecord } from '../shared/jobs'
import type { GitHubClient } from './github'

type Inspector = Pick<GitHubClient, 'repository' | 'releases' | 'workflowRuns'>
type Listener = (jobs: JobRecord[]) => void
const MAX_HISTORY = 100
const MAX_RUNNING = 2
const DEADLINE_MS = 45_000

function copy(job: JobRecord): JobRecord {
  return { ...job, output: [...job.output] }
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
      (job.kind === 'local-git-inspection' && typeof job.location === 'string' &&
        job.location.length > 0 && job.location.length <= 2048 &&
        isAbsolute(job.location) && !job.location.includes('\\0'))) &&
    job.action === 'inspect' &&
    ['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted'].includes(job.phase) &&
    typeof job.requestedAt === 'string' && job.requestedAt.length <= 40 &&
    (job.startedAt === null || typeof job.startedAt === 'string') &&
    (job.finishedAt === null || typeof job.finishedAt === 'string') &&
    typeof job.progress === 'number' && job.progress >= 0 && job.progress <= 100 &&
    Array.isArray(job.output) && job.output.length <= 24 &&
    job.output.every((line: unknown) => typeof line === 'string' && line.length <= 160) &&
    (job.errorCode === null || ['auth', 'forbidden', 'not-found', 'rate-limit',
      'network', 'timeout', 'interrupted', 'unknown'].includes(job.errorCode)))
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

  constructor(private readonly file: string, private readonly github: Inspector) {
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
      phase: 'queued', progress: 0, output: ['Repository inspection queued.'], errorCode: null
    }
    this.history.unshift(record)
    this.history = this.history.slice(0, MAX_HISTORY)
    this.publish()
    this.schedule()
    return copy(record)
  }

  /** Only the native directory picker may supply a new local path. */
  inspectLocal(pickedPath: string): JobRecord {
    this.list()
    if (typeof pickedPath !== 'string' || pickedPath.length > 2048) {
      throw new Error('Invalid local folder')
    }
    const location = realpathSync(pickedPath)
    if (!isAbsolute(location) || location.length > 2048 ||
        !statSync(location).isDirectory()) throw new Error('Invalid local folder')
    const existing = this.history.find((job) => job.kind === 'local-git-inspection' &&
      activeJob(job.phase) && job.location === location)
    if (existing) return copy(existing)
    if (this.history.filter((item) => activeJob(item.phase)).length >= 20) {
      throw new Error('Activity queue is full')
    }
    const label = basename(location).replace(/[\\x00-\\x1f\\x7f]/g, ' ').slice(0, 100) || 'Local checkout'
    const record: JobRecord = {
      id: randomUUID(), kind: 'local-git-inspection', repository: label,
      location, action: 'inspect',
      requestedAt: new Date().toISOString(), startedAt: null, finishedAt: null,
      phase: 'queued', progress: 0, output: ['Local Git inspection queued.'], errorCode: null
    }
    this.history.unshift(record)
    this.history = this.history.slice(0, MAX_HISTORY)
    this.publish()
    this.schedule()
    return copy(record)
  }

  /** Retry a previously user-selected directory, never a renderer-supplied path. */
  retryLocal(rawId: string): JobRecord {
    const id = validateJobId(rawId)
    const previous = this.history.find((job) => job.id === id)
    if (previous?.kind !== 'local-git-inspection' || !previous.location) {
      throw new Error('Local inspection not found')
    }
    return this.inspectLocal(previous.location)
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
        const localRunning = this.history.some((job) =>
          job.kind === 'local-git-inspection' && job.phase === 'running')
        const next = this.history.find((job) => job.phase === 'queued' &&
          (job.kind !== 'local-git-inspection' || !localRunning))
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
      ? 'Starting local Git inspection.' : 'Contacting GitHub for repository inspection.', 5)
    let timedOut = false
    const watchdog = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, DEADLINE_MS)
    try {
      if (job.kind === 'local-git-inspection') {
        await this.inspectWorktree(job, controller.signal)
        if (controller.signal.aborted) return
        this.finish(job, 'completed', null, 'Local Git inspection completed.')
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
      const missingGit = error instanceof GitProcessError && error.reason === 'unavailable'
      this.finish(job, 'failed', timedOut ? 'timeout' : missingGit ? 'not-found' : codeFor(error),
        timedOut ? 'Operation timed out.'
          : missingGit ? 'Git executable was not found.'
            : job.kind === 'local-git-inspection' ? 'Local Git inspection failed. Select a valid Git worktree.'
              : 'Repository inspection failed.')
    } finally {
      clearTimeout(watchdog)
      if (timedOut && job.phase === 'running') {
        this.finish(job, 'failed', 'timeout', 'Operation timed out.')
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
    const top = (await runGit([
      '-c', 'core.fsmonitor=false', '-C', job.location, 'rev-parse', '--show-toplevel'
    ], signal)).trim()
    if (!isAbsolute(top) || !top) throw new Error('Not a local Git worktree')
    const root = realpathSync(top)
    if (signal.aborted) return
    this.line(job, 'Working tree found.', 45)
    const branch = (await runGit([
      '-c', 'core.fsmonitor=false', '-C', root, 'branch', '--show-current'
    ], signal)).trim()
    if (signal.aborted) return
    const safeBranch = /^[a-zA-Z0-9._/-]{1,100}$/.test(branch)
      ? branch : branch ? '(name omitted)' : '(detached HEAD)'
    this.line(job, `Branch: ${safeBranch}.`, 60)
    let scanned = false
    const status = await runGit([
      '-c', 'core.fsmonitor=false', '-C', root,
      'status', '--porcelain=v1', '--untracked-files=normal'
    ], signal, (chunk) => {
      // Report streamed work without forwarding potentially sensitive paths.
      if (!scanned && chunk.length > 0) {
        scanned = true
        this.line(job, 'Scanning changed files.', 80)
      }
    })
    if (signal.aborted) return
    const entries = status.trimEnd() ? status.trimEnd().split('\\n') : []
    const staged = entries.filter((line) => line[0] !== ' ' && line[0] !== '?').length
    const unstaged = entries.filter((line) => line[1] !== ' ' && line[0] !== '?').length
    const untracked = entries.filter((line) => line.startsWith('??')).length
    this.line(job, `Working tree: ${entries.length ? 'changes found' : 'clean'}.`, 90)
    this.line(job, `Staged: ${staged}; modified: ${unstaged}; untracked: ${untracked}.`, 100)
  }

  private line(job: JobRecord, message: string, progress: number): void {
    if (job.phase !== 'running') return
    job.progress = progress
    job.output.push(message)
    job.output = job.output.slice(-24)
    this.publish()
  }
  private finish(job: JobRecord, phase: 'completed' | 'failed' | 'cancelled',
    errorCode: JobErrorCode | null, message: string): void {
    if (!activeJob(job.phase)) return
    job.phase = phase
    job.errorCode = errorCode
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
