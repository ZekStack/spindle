import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
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
    job.kind === 'repository-inspection' && job.action === 'inspect' &&
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
 * M2.2 will extend this registry with child-process/Git scheduling.
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
        const next = this.history.find((job) => job.phase === 'queued')
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
    this.line(job, 'Contacting GitHub for repository inspection.', 5)
    let timedOut = false
    const watchdog = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, DEADLINE_MS)
    try {
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
    } catch (error) {
      if (!activeJob(job.phase)) return
      this.finish(job, 'failed', timedOut ? 'timeout' : codeFor(error),
        timedOut ? 'Repository inspection timed out.' : 'Repository inspection failed.')
    } finally {
      clearTimeout(watchdog)
      if (timedOut && job.phase === 'running') {
        this.finish(job, 'failed', 'timeout', 'Repository inspection timed out.')
      }
      this.controllers.delete(job.id)
      this.schedule()
    }
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
