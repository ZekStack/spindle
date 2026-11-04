import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import {
  DebInstallError, installVerifiedDeb, installedDebVersion,
  normalizedDebVersion, type DebSystem
} from '../../src/main/deb-install'
import { verifyRunningDebPackage } from '../../src/main/deb-preflight'
import { isEligibleUpdate } from '../../src/shared/update-policy'

// Only run on an ephemeral CI runner: the test intentionally replaces the
// installed system package. It never contacts GitHub or publishes a release.
if (process.env.CI !== 'true' || process.env.SPINDLE_NATIVE_DEB_UPGRADE !== '1' ||
    process.platform !== 'linux') {
  throw new Error('Native Debian upgrade integration requires an opted-in Linux CI runner')
}

const oldVersion = '0.1.0-rc.9000'
const newVersion = '0.1.0-rc.9001'
const executable = '/opt/Spindle/spindle'
const newDeb = resolve('release', `Spindle-${newVersion}-linux-x64.deb`)
const execFileAsync = promisify(execFile)
const commands: string[] = []

assert.equal(isEligibleUpdate(oldVersion, newVersion), true)

const runner: DebSystem = {
  async run(command, args) {
    if (!['dpkg-query', 'dpkg-deb'].includes(command)) {
      throw new Error('Unexpected command in Debian integration runner')
    }
    const { stdout } = await execFileAsync(command, args, {
      timeout: 300_000, encoding: 'utf8', maxBuffer: 128 * 1024
    })
    return stdout.trim()
  },
  async sha512(file) {
    const hash = createHash('sha512')
    for await (const chunk of createReadStream(file)) hash.update(chunk)
    return hash.digest('base64')
  },
  async isRegularFile(file) {
    const info = await lstat(file)
    return info.isFile() && !info.isSymbolicLink()
  }
}

async function assertPackageVersion(version: string): Promise<void> {
  const installed = await installedDebVersion(executable, runner)
  assert.equal(normalizedDebVersion(installed ?? ''), version)
  await verifyRunningDebPackage(executable, version, runner)
}

await assertPackageVersion(oldVersion)
const sha512 = await runner.sha512(newDeb)
const request = { file: newDeb, expectedVersion: newVersion, sha512, executable }

// Exercise a refused polkit authorization using the real DEB metadata and
// checksum, but no privileged command. Production maps this to install-failed.
const deniedRunner: DebSystem = {
  ...runner,
  async run(command, args) {
    if (command === '/usr/bin/pkexec') {
      assert.deepEqual(args, ['/usr/bin/dpkg', '--install', newDeb])
      commands.push('denied')
      throw new Error('Simulated authorization cancellation')
    }
    return runner.run(command, args)
  }
}
await assert.rejects(
  () => installVerifiedDeb(request, deniedRunner),
  (error) => error instanceof DebInstallError && error.reason === 'package-manager'
)
assert.deepEqual(commands, ['denied'])
await assertPackageVersion(oldVersion)

// Only the elevation adapter differs: the production verification code and
// exact dpkg --install argument array are unchanged. CI has passwordless sudo;
// the real pkexec dialog must still be manually tested on Linux Mint.
const ciInstaller: DebSystem = {
  ...runner,
  async run(command, args) {
    if (command === '/usr/bin/pkexec') {
      assert.deepEqual(args, ['/usr/bin/dpkg', '--install', newDeb])
      const { stdout } = await execFileAsync('sudo', args, {
        timeout: 300_000, encoding: 'utf8', maxBuffer: 128 * 1024
      })
      commands.push('installed')
      return stdout.trim()
    }
    return runner.run(command, args)
  }
}
const installed = await installVerifiedDeb(request, ciInstaller)
assert.equal(normalizedDebVersion(installed.installedVersion), newVersion)
assert.deepEqual(commands, ['denied', 'installed'])
await assertPackageVersion(newVersion)
console.log(`Native Debian package upgrade passed: ${oldVersion} -> ${newVersion}`)
