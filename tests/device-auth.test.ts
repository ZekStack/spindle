import test from 'node:test'
import assert from 'node:assert/strict'
import { GitHubDeviceAuth } from '../src/main/device-auth'
import type { DeviceAuthProgress } from '../src/shared/contracts'

const code = {
  device_code: 'd'.repeat(40),
  user_code: 'ABCD-EFGH',
  verification_uri: 'https://github.com/login/device',
  expires_in: 900,
  interval: 5
}
const token = 'ghu_' + 'Z'.repeat(36)
const json = (value: unknown) => Response.json(value)

test('device login returns only public code, respects GitHub poll interval, and stores token after viewer verification', async () => {
  let clock = 1_000
  const requests: { path: string; authorization: string | null }[] = []
  let saved: string | null = null
  let tokenCalls = 0
  const request = (async (url: string | URL | Request, options?: RequestInit) => {
    const path = new URL(String(url)).pathname
    requests.push({
      path, authorization: new Headers(options?.headers).get('Authorization')
    })
    if (path === '/login/device/code') return json(code)
    if (path === '/login/oauth/access_token') {
      tokenCalls++
      return json(tokenCalls === 1 ? { error: 'authorization_pending' }
        : { access_token: token, token_type: 'bearer', scope: 'repo,read:org' })
    }
    if (path === '/user') return json({ login: 'ExampleUser' })
    throw new Error('Unexpected URL')
  }) as typeof fetch
  const device = new GitHubDeviceAuth(request, {
    available: async () => true,
    save: async (value) => { saved = value },
    clear: async () => { saved = null }
  }, () => clock)
  const started = await device.start('Ov23li12345678901234')
  assert.deepEqual(started, {
    userCode: 'ABCD-EFGH',
    verificationUrl: 'https://github.com/login/device',
    expiresAt: 901_000,
    nextPollAt: 6_000
  })
  assert.equal(JSON.stringify(started).includes(code.device_code), false)
  assert.equal((await device.poll()).phase, 'pending')
  assert.equal(tokenCalls, 0)
  clock = 6_000
  assert.equal((await device.poll()).phase, 'pending')
  assert.equal(tokenCalls, 1)
  clock = 11_000
  const complete = await device.poll()
  assert.deepEqual(complete, { phase: 'complete', nextPollAt: null })
  assert.equal(saved, token)
  assert.equal(JSON.stringify(complete).includes(token), false)
  assert.equal(requests.find((entry) => entry.path === '/user')?.authorization, 'Bearer ' + token)
  await device.signOut()
  assert.equal(saved, null)
})

test('GitHub slow_down enforces increased rate limit without leaking device secret', async () => {
  let clock = 0
  let polls = 0
  const request = (async (url: string | URL | Request) => {
    if (String(url).endsWith('/device/code')) return json(code)
    polls++
    return json({ error: 'slow_down' })
  }) as typeof fetch
  const device = new GitHubDeviceAuth(request, {
    available: async () => true,
    save: async () => {},
    clear: async () => {}
  }, () => clock)
  await device.start('Iv1.123456789abcdef0')
  clock = 5_000
  const result = await device.poll()
  assert.deepEqual(result, { phase: 'pending', nextPollAt: 15_000 })
  clock = 10_000
  assert.equal((await device.poll()).nextPollAt, 15_000)
  assert.equal(polls, 1)
})

test('cancellation prevents late GitHub authorization responses being saved', async () => {
  let reply: ((value: Response) => void) | undefined
  let saved = false
  let clock = 0
  const device = new GitHubDeviceAuth(
    (async (url: string | URL | Request) => {
      if (String(url).endsWith('/device/code')) return json(code)
      return new Promise<Response>((resolve) => { reply = resolve })
    }) as typeof fetch,
    { available: async () => true, save: async () => { saved = true }, clear: async () => {} },
    () => clock
  )
  await device.start('Iv1.123456789abcdef0')
  clock = 5_000
  const pending = device.poll()
  device.cancel()
  reply?.(json({ access_token: token, token_type: 'bearer' }))
  assert.equal((await pending).phase, 'cancelled')
  assert.equal(saved, false)
})

test('device flow fails closed without a secure store or validated GitHub response', async () => {
  const unavailable = new GitHubDeviceAuth(
    (async () => json(code)) as typeof fetch,
    { available: async () => false, save: async () => {}, clear: async () => {} }
  )
  await assert.rejects(() => unavailable.start('Iv1.123456789abcdef0'), /Secure credential/)
  for (const bad of [
    { ...code, verification_uri: 'https://evil.example/login' },
    { ...code, device_code: token, expires_in: -1 }
  ]) {
    const device = new GitHubDeviceAuth(
      (async () => json(bad)) as typeof fetch,
      { available: async () => true, save: async () => {}, clear: async () => {} }
    )
    await assert.rejects(() => device.start('Iv1.123456789abcdef0'), /Invalid GitHub/)
  }
})

test('denied authorization never persists credentials', async () => {
  let clock = 0
  let saves = 0
  const device = new GitHubDeviceAuth(
    (async (url: string | URL | Request) => String(url).endsWith('/device/code')
      ? json(code) : json({ error: 'access_denied' })) as typeof fetch,
    { available: async () => true, save: async () => { saves++ }, clear: async () => {} },
    () => clock
  )
  await device.start('Iv1.123456789abcdef0')
  clock = 5_000
  const result: DeviceAuthProgress = await device.poll()
  assert.equal(result.phase, 'denied')
  assert.equal(saves, 0)
})
