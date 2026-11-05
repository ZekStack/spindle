import { spawn } from 'node:child_process'

export type GitProcessFailure = 'unavailable' | 'failed' | 'output-limit'

/** Git output is never put into Activity history: callers must summarize it. */
export class GitProcessError extends Error {
  constructor(readonly reason: GitProcessFailure) {
    super(reason)
    this.name = 'GitProcessError'
  }
}

const MAX_OUTPUT = 1024 * 1024

/**
 * Run only fixed, caller-owned Git argument arrays. No shell, credential
 * prompt, inherited stdin or raw stderr. Cancellation kills the child and
 * waits for its close event before the caller can release the job slot.
 */
export function runGit(
  args: readonly string[],
  signal: AbortSignal,
  onStdout?: (chunk: string) => void
): Promise<string> {
  if (signal.aborted) return Promise.reject(new DOMException('Cancelled', 'AbortError'))
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...args], {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GCM_INTERACTIVE: 'never',
        GIT_OPTIONAL_LOCKS: '0',
        LC_ALL: 'C'
      }
    })
    let buffer = ''
    let bytes = 0
    let overflow = false
    let spawnError: Error | null = null
    let cancelled = false

    const abort = () => {
      cancelled = true
      child.kill()
    }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk)
      if (bytes > MAX_OUTPUT) {
        overflow = true
        child.kill()
        return
      }
      buffer += chunk
      // Callback receives untrusted Git output inside main only.
      // Never forward raw chunks over IPC or persist them.
      if (!cancelled) onStdout?.(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > MAX_OUTPUT) {
        overflow = true
        child.kill()
      }
    })
    child.on('error', (error) => { spawnError = error })
    child.on('close', (code) => {
      signal.removeEventListener('abort', abort)
      if (cancelled || signal.aborted) {
        reject(new DOMException('Cancelled', 'AbortError'))
      } else if (overflow) {
        reject(new GitProcessError('output-limit'))
      } else if (spawnError) {
        reject(new GitProcessError('unavailable'))
      } else if (code !== 0) {
        reject(new GitProcessError('failed'))
      } else {
        resolve(buffer)
      }
    })
  })
}
