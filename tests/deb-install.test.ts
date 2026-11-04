import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  DebInstallError, installVerifiedDeb, installedDebVersion,
  normalizedDebVersion, type DebSystem
} from '../src/main/deb-install'
import {
  clearInstallAttempt, previousInstallUnapplied, recordInstallAttempt
} from '../src/main/update-attempt'

const EXE = '/opt/Spindle/spindle'
const FILE = '/home/test/.cache/spindle-updater/pending/Spindle-0.1.0-rc.3-linux-x64.deb'
const HASH = 'A'.repeat(86) + '=='

function fakeInstaller(options: {
  executableOwner?: boolean; checksum?: string; pkg?: string;
  version?: string; failElevation?: boolean; doNotUpgrade?: boolean
} = {}) {
  let currentVersion = '0.1.0~rc.2'
  const calls: { command: string; args: string[] }[] = []
  const runner: DebSystem = {
    async run(command, args) {
      calls.push({ command, args })
      if (command === 'dpkg-query' && args[0] === '--search') {
        if (options.executableOwner === false) throw new Error('not managed by dpkg')
        return 'spindle: /opt/Spindle/spindle'
      }
      if (command === 'dpkg-query' && args[0] === '--show') return currentVersion
      if (command === 'dpkg-deb') return (options.pkg ?? 'spindle') + '\n' + (options.version ?? '0.1.0~rc.3')
      if (command === '/usr/bin/pkexec') {
        if (options.failElevation) throw new Error('polkit authorization dismissed')
        if (!options.doNotUpgrade) currentVersion = options.version ?? '0.1.0~rc.3'
        return ''
      }
      throw new Error('Unexpected program: ' + command)
    },
    async sha512() { return options.checksum ?? HASH },
    async isRegularFile() { return true }
  }
  return { runner, calls }
}

const request = { executable: EXE, file: FILE, sha512: HASH, expectedVersion: '0.1.0-rc.3' }

test('normalizes only Debian prerelease representation', () => {
  assert.equal(normalizedDebVersion('0.1.0~rc.3'), '0.1.0-rc.3')
  assert.equal(normalizedDebVersion('0.1.0'), '0.1.0')
})

test('confirms package identity, hash, dpkg result and version before permitting relaunch', async () => {
  const { runner, calls } = fakeInstaller()
  assert.equal(await installedDebVersion(EXE, runner), '0.1.0~rc.2')
  const result = await installVerifiedDeb(request, runner)
  assert.equal(result.installedVersion, '0.1.0~rc.3')
  assert.deepEqual(calls.find((call) => call.command === '/usr/bin/pkexec')?.args,
    ['/usr/bin/dpkg', '--install', FILE])
  assert.ok(!calls.some((call) => call.command === '/bin/bash'))
})

test('rejects a different or unpacked executable before elevation', async () => {
  const { runner, calls } = fakeInstaller({ executableOwner: false })
  await assert.rejects(() => installVerifiedDeb(request, runner), (error) =>
    error instanceof DebInstallError && error.reason === 'not-deb-install')
  assert.equal(calls.some((call) => call.command === '/usr/bin/pkexec'), false)
})

test('never elevates a tampered or mismatched artifact', async () => {
  for (const options of [
    { checksum: 'B'.repeat(86) + '==' },
    { pkg: 'another-application' },
    { version: '0.1.0~rc.4' }
  ]) {
    const { runner, calls } = fakeInstaller(options)
    await assert.rejects(() => installVerifiedDeb(request, runner), DebInstallError)
    assert.equal(calls.some((call) => call.command === '/usr/bin/pkexec'), false)
  }
})

test('pkexec failure and unchanged installed package are errors, not a successful restart', async () => {
  for (const [options, reason] of [
    [{ failElevation: true }, 'package-manager'],
    [{ doNotUpgrade: true }, 'version-mismatch']
  ] as const) {
    const { runner } = fakeInstaller(options)
    await assert.rejects(() => installVerifiedDeb(request, runner), (error) =>
      error instanceof DebInstallError && error.reason === reason)
  }
})

test('records a restart handoff and reports unchanged running versions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'spindle-update-test-'))
  const state = join(dir, 'update-attempt.json')
  const now = Date.now()
  try {
    recordInstallAttempt(state, '0.1.0-rc.2', '0.1.0-rc.3', now)
    assert.equal(previousInstallUnapplied(state, '0.1.0-rc.2', now + 1000), true)
    assert.equal(previousInstallUnapplied(state, '0.1.0-rc.3', now + 1000), false)
    recordInstallAttempt(state, '0.1.0-rc.2', '0.1.0-rc.3', now)
    assert.equal(previousInstallUnapplied(state, '0.1.0-rc.2', now + 8 * 86_400_000), false)
    clearInstallAttempt(state)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
