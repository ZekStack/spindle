import { managedGitHubToken } from './managed-token'
import { LOGIN_PATTERN } from '../shared/contracts'
import type { DeviceAuthProgress, DeviceAuthSetup, DeviceAuthStart } from '../shared/contracts'

type TokenStore = Pick<typeof managedGitHubToken, 'available' | 'save' | 'clear'>
type Session = {
  clientId: string
  deviceCode: string
  userCode: string
  expiresAt: number
  intervalMs: number
  nextPollAt: number
}

const DEVICE_URL = 'https://github.com/login/device/code'
const TOKEN_URL = 'https://github.com/login/oauth/access_token'
const USER_URL = 'https://api.github.com/user'
const VERIFY_URL = 'https://github.com/login/device'

/**
 * Main-only GitHub OAuth device flow. Device code and access token are never
 * returned through IPC. Polling is rate-limited even for malicious renderers.
 */
export class GitHubDeviceAuth {
  private session: Session | null = null
  private pollJob: Promise<DeviceAuthProgress> | null = null
  private generation = 0

  constructor(
    private readonly request: typeof fetch = fetch,
    private readonly tokens: TokenStore = managedGitHubToken,
    private readonly now: () => number = Date.now
  ) {}

  async setup(): Promise<DeviceAuthSetup> {
    const env = process.env.SPINDLE_GITHUB_CLIENT_ID?.trim() || ''
    return {
      secureStorage: await this.tokens.available(),
      configuredClientId: validClientId(env) ? env : null
    }
  }

  async start(rawClientId?: string): Promise<DeviceAuthStart> {
    if (!(await this.tokens.available())) {
      throw new Error('Secure credential storage is unavailable')
    }
    const candidate = (rawClientId || process.env.SPINDLE_GITHUB_CLIENT_ID || '').trim()
    if (!validClientId(candidate)) throw new Error('A valid OAuth application client ID is required')
    // A prior delayed device-code response must not replace a newer session.
    const generation = ++this.generation
    this.session = null
    let response: Response
    try {
      response = await this.post(DEVICE_URL, { client_id: candidate, scope: 'repo read:org' })
    } catch { throw new Error('Unable to contact GitHub for sign-in') }
    if (generation !== this.generation) throw new Error('Sign-in request was cancelled')
    if (!response.ok) throw new Error('GitHub did not accept the OAuth application')
    let data: Record<string, unknown>
    try { data = await response.json() as Record<string, unknown> }
    catch { throw new Error('Invalid GitHub device authorization response') }
    if (typeof data.device_code !== 'string' ||
        !/^[A-Za-z0-9_-]{16,256}$/.test(data.device_code) ||
        typeof data.user_code !== 'string' ||
        !/^[A-Za-z0-9-]{6,24}$/.test(data.user_code) ||
        data.verification_uri !== VERIFY_URL ||
        !Number.isInteger(data.expires_in) ||
        Number(data.expires_in) < 60 || Number(data.expires_in) > 1800) {
      throw new Error('Invalid GitHub device authorization response')
    }
    const interval = typeof data.interval === 'number'
      ? Math.max(5, Math.min(60, data.interval)) : 5
    if (generation !== this.generation) throw new Error('Sign-in request was cancelled')
    const intervalMs = Math.ceil(interval) * 1000
    const now = this.now()
    this.session = {
      clientId: candidate, deviceCode: data.device_code, userCode: data.user_code,
      expiresAt: now + Number(data.expires_in) * 1000,
      intervalMs, nextPollAt: now + intervalMs
    }
    return {
      userCode: data.user_code, verificationUrl: VERIFY_URL,
      expiresAt: this.session.expiresAt, nextPollAt: this.session.nextPollAt
    }
  }

  async poll(): Promise<DeviceAuthProgress> {
    if (this.pollJob) return this.pollJob
    const session = this.session
    if (!session) return { phase: 'cancelled', nextPollAt: null }
    if (this.now() >= session.expiresAt) {
      this.session = null
      return { phase: 'expired', nextPollAt: null }
    }
    if (this.now() < session.nextPollAt) {
      return { phase: 'pending', nextPollAt: session.nextPollAt }
    }
    // Advance before making the request so concurrent invocations cannot
    // bypass GitHub's interval.
    session.nextPollAt = this.now() + session.intervalMs
    const job = this.performPoll(session)
    this.pollJob = job
    try { return await job }
    finally { if (this.pollJob === job) this.pollJob = null }
  }

  cancel(): void {
    this.generation++
    this.session = null
  }

  async signOut(): Promise<void> {
    this.cancel()
    // Never touch external gh or environment credentials.
    await this.tokens.clear()
  }

  private async performPoll(session: Session): Promise<DeviceAuthProgress> {
    const pending = (networkError = false): DeviceAuthProgress => ({
      phase: 'pending', nextPollAt: session.nextPollAt,
      ...(networkError ? { networkError: true } : {})
    })
    let response: Response
    try {
      response = await this.post(TOKEN_URL, {
        client_id: session.clientId, device_code: session.deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
      })
    } catch { return pending(true) }
    if (this.session !== session) return { phase: 'cancelled', nextPollAt: null }
    if (!response.ok) return pending(true)
    let result: Record<string, unknown>
    try { result = await response.json() as Record<string, unknown> }
    catch { return pending(true) }
    if (this.session !== session) return { phase: 'cancelled', nextPollAt: null }
    if (result.error === 'authorization_pending') return pending()
    if (result.error === 'slow_down') {
      session.intervalMs = Math.min(120_000, session.intervalMs + 5_000)
      session.nextPollAt = this.now() + session.intervalMs
      return pending()
    }
    if (result.error === 'access_denied' || result.error === 'expired_token') {
      this.session = null
      return { phase: result.error === 'access_denied' ? 'denied' : 'expired', nextPollAt: null }
    }
    if (typeof result.error === 'string') {
      this.session = null
      return { phase: 'failed', nextPollAt: null }
    }
    const token = result.access_token
    if (typeof token !== 'string' || !/^[A-Za-z0-9_.-]{20,2048}$/.test(token) ||
        (typeof result.token_type === 'string' &&
          result.token_type.toLowerCase() !== 'bearer')) {
      this.session = null
      return { phase: 'failed', nextPollAt: null }
    }

    // Verify that GitHub accepted the token before changing credentials.
    try {
      const viewer = await this.request(USER_URL, {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'User-Agent': 'Spindle-Desktop'
        }, signal: AbortSignal.timeout(12_000)
      })
      if (this.session !== session) return { phase: 'cancelled', nextPollAt: null }
      if (!viewer.ok) {
        this.session = null
        return { phase: 'failed', nextPollAt: null }
      }
      const info = await viewer.json() as { login?: unknown }
      if (typeof info.login !== 'string' || !LOGIN_PATTERN.test(info.login)) {
        this.session = null
        return { phase: 'failed', nextPollAt: null }
      }
      if (this.session !== session) return { phase: 'cancelled', nextPollAt: null }
      await this.tokens.save(token, info.login)
      if (this.session !== session) {
        await this.tokens.clear()
        return { phase: 'cancelled', nextPollAt: null }
      }
      this.session = null
      return { phase: 'complete', nextPollAt: null }
    } catch {
      // Only a safe category reaches the renderer; no HTTP/token details.
      this.session = null
      return { phase: 'failed', nextPollAt: null }
    }
  }

  private post(url: string, values: Record<string, string>): Promise<Response> {
    return this.request(url, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(values),
      signal: AbortSignal.timeout(12_000)
    })
  }
}

function validClientId(value: string): boolean {
  return /^[A-Za-z0-9_.-]{8,128}$/.test(value)
}

export const githubDeviceAuth = new GitHubDeviceAuth()
