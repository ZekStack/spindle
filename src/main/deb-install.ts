import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const PACKAGE_NAME = 'spindle'

export type InstallFailureCode = 'verification' | 'wrong-package' | 'not-deb-install' | 'package-manager' | 'version-mismatch'

export class DebInstallError extends Error {
  constructor(readonly reason: InstallFailureCode, message: string) {
    super(message)
    this.name = 'DebInstallError'
  }
}

export interface DebSystem {
  run(command: string, args: string[]): Promise<string>
  sha512(path: string): Promise<string>
  isRegularFile(path: string): Promise<boolean>
}

const system: DebSystem = {
  async run(command, args) {
    const { stdout } = await execFileAsync(command, args, {
      timeout: 300_000,
      encoding: 'utf8',
      maxBuffer: 128 * 1024,
      windowsHide: true
    })
    return stdout.trim()
  },
  async sha512(path) {
    const hash = createHash('sha512')
    for await (const chunk of createReadStream(path)) hash.update(chunk)
    return hash.digest('base64')
  },
  async isRegularFile(path) {
    const info = await lstat(path)
    return info.isFile() && !info.isSymbolicLink()
  }
}

export function normalizedDebVersion(value: string): string {
  // Debian represents prereleases with a tilde: 0.2.0~rc.3.
  return value.trim().replace('~rc.', '-rc.')
}

export async function installedDebVersion(executable: string, runner: DebSystem = system): Promise<string | null> {
  try {
    // Never attempt a privileged DEB install from an unpacked or AppImage copy.
    const owner = await runner.run('dpkg-query', ['--search', executable])
    if (!owner.split('\n').some((line) => /^spindle(?::[a-z0-9_-]+)?:\s/.test(line))) return null
    return (await runner.run('dpkg-query', ['--show', '--showformat=${Version}', PACKAGE_NAME])).trim()
  } catch {
    return null
  }
}

export interface DebInstallRequest {
  file: string
  expectedVersion: string
  sha512: string
  executable: string
}

export async function installVerifiedDeb(
  request: DebInstallRequest,
  runner: DebSystem = system
): Promise<{ installedVersion: string }> {
  const { file, expectedVersion, executable, sha512 } = request
  if (!file.endsWith('.deb') || !/^[a-zA-Z0-9+/]{85,87}={0,2}$/.test(sha512)) {
    throw new DebInstallError('verification', 'Missing verified Debian package metadata')
  }

  if (!(await installedDebVersion(executable, runner))) {
    throw new DebInstallError('not-deb-install', 'The running executable is not owned by the installed Spindle Debian package')
  }
  if (!(await runner.isRegularFile(file)) || (await runner.sha512(file)) !== sha512) {
    throw new DebInstallError('verification', 'The downloaded Debian package does not match its release checksum')
  }

  let fields: string
  try { fields = await runner.run('dpkg-deb', ['--field', file, 'Package', 'Version']) }
  catch {
    throw new DebInstallError('wrong-package', 'Cannot read the downloaded Debian package metadata')
  }
  // dpkg-deb --field returns labeled lines: "Package: spindle", etc.
  const name = /^Package:\s*(.+)$/im.exec(fields)?.[1].trim()
  const packageVersion = /^Version:\s*(.+)$/im.exec(fields)?.[1].trim()
  if (name !== PACKAGE_NAME || !packageVersion ||
      normalizedDebVersion(packageVersion) !== expectedVersion) {
    throw new DebInstallError('wrong-package', 'Downloaded Debian package name or version does not match the release')
  }

  try {
    // Invoke a fixed system tool with argument arrays: no shell and no
    // user-supplied command. pkexec displays the elevated dpkg invocation.
    await runner.run('/usr/bin/pkexec', ['/usr/bin/dpkg', '--install', file])
  } catch {
    throw new DebInstallError('package-manager', 'The Debian package manager rejected or cancelled the installation')
  }

  let actual: string
  try { actual = (await runner.run('dpkg-query', ['--show', '--showformat=${Version}', PACKAGE_NAME])).trim() }
  catch { actual = '' }
  if (actual !== packageVersion.trim()) {
    throw new DebInstallError('version-mismatch', 'The system package version did not change to the expected version')
  }
  return { installedVersion: actual }
}
