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
const STOP_GRACE_MS = 1500

/**
 * Execute fixed caller-owned Git arguments, never a shell command.
 * Child output and credentials are not exposed through IPC or logs.
 * On POSIX, Git and its subprocesses are placed in their own process
 * group so cancellation cleans up descendants, not just the parent.
 */
export function runGit(
  args: readonly string[],
  signal: AbortSignal,
  onStdout?: (chunk: string) => void,
  onStderr?: (chunk: string) => void
): Promise<string> {
  if (signal.aborted) return Promise.reject(new DOMException('Cancelled', 'AbortError'))
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...args], {
      shell: false,
      detached: process.platform !== 'win32',
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
    let spawnError = false
    let callbackFailed = false
    let cancelled = false
    let closed = false
    let escalation: NodeJS.Timeout | null = null

    function kill(hard: boolean) {
      const sig: NodeJS.Signals = hard ? 'SIGKILL' : 'SIGTERM'
      // Only negative PIDs refer to the child's own detached POSIX
      // process group; never target the caller's process group.
      if (process.platform !== 'win32' && child.pid) {
        try {
          process.kill(-child.pid, sig)
          return
        } catch { /* Process exited; fall back to the direct child. */ }
      }
      try { child.kill(sig) } catch { /* Process already exited. */ }
    }

    function stop() {
      if (closed || escalation) return
      kill(false)
      escalation = setTimeout(() => {
        if (!closed) kill(true)
      }, STOP_GRACE_MS)
      escalation.unref()
    }

    const abort = () => {
      cancelled = true
      stop()
    }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk)
      if (bytes > MAX_OUTPUT) {
        overflow = true
        stop()
        return
      }
      buffer += chunk
      if (!cancelled && !overflow) {
        try { onStdout?.(chunk) }
        catch {
          // A subscriber's failure must not crash the Electron main process
          // or leave a runaway Git child.
          callbackFailed = true
          stop()
        }
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > MAX_OUTPUT) {
        overflow = true
        stop()
        return
      }
      if (!cancelled && !overflow) {
        try { onStderr?.(chunk.toString('utf8')) }
        catch {
          callbackFailed = true
          stop()
        }
      }
    })
    child.on('error', () => { spawnError = true })
    child.on('close', (code) => {
      closed = true
      if (escalation) clearTimeout(escalation)
      signal.removeEventListener('abort', abort)
      if (cancelled || signal.aborted) {
        reject(new DOMException('Cancelled', 'AbortError'))
      } else if (overflow) {
        reject(new GitProcessError('output-limit'))
      } else if (spawnError) {
        reject(new GitProcessError('unavailable'))
      } else if (callbackFailed || code !== 0) {
        reject(new GitProcessError('failed'))
      } else {
        resolve(buffer)
      }
    })
  })
}
