import test from 'node:test'
import assert from 'node:assert/strict'
import { DebInstallError, type DebSystem } from '../src/main/deb-install'
import { verifyRunningDebPackage } from '../src/main/deb-preflight'

function fakeSystem(version: string, owner = 'spindle: /opt/Spindle/spindle') {
  const calls: string[] = []
  const runner: DebSystem = {
    async run(command, args) {
      calls.push([command, ...args].join(' '))
      if (command === 'dpkg-query' && args[0] === '--search') return owner
      if (command === 'dpkg-query' && args[0] === '--show') return version
      throw new Error('Unexpected command')
    },
    async sha512() { throw new Error('Preflight must not hash downloaded artifacts') },
    async isRegularFile() { throw new Error('Preflight must not read downloaded artifacts') }
  }
  return { runner, calls }
}

test('accepts an installed DEB matching the running stable or RC version', async () => {
  for (const [installed, running] of [
    ['0.1.0~rc.8', '0.1.0-rc.8'],
    ['0.1.0', '0.1.0']
  ]) {
    const { runner, calls } = fakeSystem(installed)
    await verifyRunningDebPackage('/opt/Spindle/spindle', running, runner)
    assert.equal(calls.length, 2)
    assert.ok(calls.every((call) => call.startsWith('dpkg-query ')))
  }
})

test('rejects an executable not owned by the installed Spindle DEB', async () => {
  const { runner, calls } = fakeSystem('0.1.0~rc.8', 'other-package: /tmp/spindle')
  await assert.rejects(
    () => verifyRunningDebPackage('/tmp/spindle', '0.1.0-rc.8', runner),
    (error) => error instanceof DebInstallError && error.reason === 'not-deb-install'
  )
  assert.equal(calls.length, 1)
})

test('rejects a stale running binary even when its path belongs to the DEB', async () => {
  const { runner } = fakeSystem('0.1.0~rc.8')
  await assert.rejects(
    () => verifyRunningDebPackage('/opt/Spindle/spindle', '0.1.0-rc.7', runner),
    (error) => error instanceof DebInstallError && error.reason === 'version-mismatch'
  )
})

test('fails closed when dpkg package ownership or version cannot be queried', async () => {
  const { runner } = fakeSystem('0.1.0~rc.8')
  runner.run = async () => { throw new Error('dpkg-query unavailable') }
  await assert.rejects(
    () => verifyRunningDebPackage('/opt/Spindle/spindle', '0.1.0-rc.8', runner),
    (error) => error instanceof DebInstallError && error.reason === 'not-deb-install'
  )
})
