import {
  DebInstallError, installedDebVersion, normalizedDebVersion, type DebSystem
} from './deb-install'

/**
 * Verify that the running executable is the installed DEB and that it matches
 * the installed package version before contacting GitHub or downloading files.
 * The install step repeats its own checks, since the package can change later.
 */
export async function verifyRunningDebPackage(
  executable: string,
  runningVersion: string,
  runner?: DebSystem
): Promise<void> {
  const installedVersion = await installedDebVersion(executable, runner)
  if (installedVersion === null) {
    throw new DebInstallError('not-deb-install',
      'The running executable is not owned by the installed Spindle Debian package')
  }
  if (normalizedDebVersion(installedVersion) !== runningVersion) {
    throw new DebInstallError('version-mismatch',
      'The running Spindle version differs from the installed Debian package')
  }
}
