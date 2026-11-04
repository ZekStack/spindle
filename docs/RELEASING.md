# Releasing Spindle

Spindle publishes installers automatically when a supported version tag is
pushed. The CI workflow builds the exact tagged commit on Ubuntu and Windows
GitHub-hosted runners, then publishes only after **both** build jobs succeed.

## Tag format

- Stable release: `v0.1.0`, `v1.2.3`
- Release candidate: `v0.1.0-rc.1`, `v0.1.0-rc.2`
- Pattern: `vMAJOR.MINOR.PATCH[-rc.N]`
- RC releases are **prereleases** and do not replace the latest stable release.
- Other prerelease qualifiers and tags with leading zeros are rejected.

## Recommended release process

1. Merge to `main`; ensure Windows and Linux CI is green.
2. Review the commit to release and choose the correct version.
3. Tag that exact commit, then push the tag:

```bash
git switch main
git pull --ff-only
git tag -a v0.1.0-rc.1 -m "Spindle v0.1.0-rc.1"
git push origin v0.1.0-rc.1
```

4. Observe the **Release** GitHub Actions workflow.
5. After success, download the assets from the corresponding GitHub release.

## Native installer smoke gate on release tags

The tagged **Release** workflow now tests its actual tag-stamped installers
before uploading artifacts or publishing a GitHub Release. This differs
from ordinary PR CI, where the package version is the unstamped source
version, and from synthetic two-version CI upgrades.

After the existing build, manifest and asset checks, the Linux builder:

- Installs its exact release-version `.deb` using APT on the ephemeral
  Ubuntu runner and verifies the real `dpkg-query` version.
- Launches the installed `/opt/Spindle/spindle` under Xvfb. The built-in
  smoke test checks the active DEB updater identity, Electron version,
  sandboxed preload and renderer IPC.
- Launches the actual `.AppImage` under Xvfb using the supported
  `APPIMAGE_EXTRACT_AND_RUN=1` fallback (no FUSE requirement). It checks
  the AppImage runtime path, updater identity, running version and IPC.

The Windows builder silently installs its exact tagged NSIS package to an
isolated, non-system directory on the disposable runner. It launches the
installed executable, checks `nsis` updater identity, Electron version,
preload and IPC, and requires a test-only result file.

**All checks must pass before the publish job can run.** None downloads a
newer release or tests the interactive authorization/restart handoff;
the full two-version Mint/AppImage/Windows update QA in M0.2–M0.5 remains
open. These checks protect against shipping a tagged installer that cannot
launch or whose packaged version does not match the tag.

## Files available on each release

| Platform | File |
| --- | --- |
| Debian / Ubuntu / Linux Mint | `Spindle-VERSION-linux-x64.deb` |
| Linux portable | `Spindle-VERSION-linux-x64.AppImage` |
| Windows installer | `Spindle-Setup-VERSION-windows-x64.exe` |
| All | `SHA256SUMS.txt` |

This first stage targets x64 only. AppImage users may need `chmod +x`
before launching the file. Windows installers are **not yet code signed**, so
SmartScreen may warn. Test actual packaged applications before public
promotion; build/test checks alone are insufficient.

## Reruns and failures

Build jobs never publish individual partial releases. All three installer
filenames must be present before the release-publishing job continues.

The publishing job uses the GitHub-provided token; only that job has
`contents: write`. It checks for an existing release on rerun, resumes matching draft
uploads, and repairs conflicting **draft** assets before publishing. It never
replaces conflicting assets on an already published release. Published assets
with matching SHA-256 digests are left unchanged; use a new tag for fixes.

Tags are never force-moved by the release workflow. Use a new version (or RC
counter) to correct an already published release.

## Local packaging

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm pack:linux # Linux
pnpm pack:win   # Windows
```

The `scripts/prepare-release.mjs` command stamps the package version
from the pushed tag in the *temporary CI checkout*, not in repository source.
`scripts/generate-icons.mjs` produces Linux PNG and Windows ICO artwork
from a single self-contained design.

## Auto-update metadata

Each platform build must produce update feed metadata as well as its installer:
Windows produces `latest.yml`; Linux produces the appropriate
`latest-linux*.yml` manifest(s). The release workflow uploads them alongside
installer files and checksums. The publication job stops if any required
metadata or platform installer is missing.

The first updater-enabled RC is a manual upgrade from `v0.1.0-rc.1` (that
earlier binary has no update checker). To test the updater, install the first
updater-enabled RC, publish the next RC, and verify launch check, confirmation,
download, checksum verification, and installation on Windows, AppImage, and
DEB. Do not assume passing build CI is equivalent to successful auto-update.

The GitHub repo is private during early development; updater authentication
uses the user's existing GitHub CLI token or a runtime GH_TOKEN. No credentials
are distributed inside applications.

## Native installed Debian smoke in CI

The Linux CI workflow now installs the **actual generated DEB** with
`apt-get` on a disposable GitHub-hosted Ubuntu runner, checks the installed
package version with `dpkg-query`, and launches the installed executable
under Xvfb in smoke mode. The running Electron main process then verifies:

- The packaged updater detects the Debian format from the shipped
  `resources/package-type` marker and reports an idle update state.
- The running executable belongs to the installed `spindle` DEB, and its
  Electron version matches the installed Debian version.
- The sandboxed preload and typed renderer IPC can retrieve the workspace
  and update status from the installed application.

The existing uninstalled Electron smoke runs separately and expects updates
to remain disabled. The installed-DEB CI test uses real `dpkg-query`, but
it **does not** download a newer release, perform a privileged update,
relaunch a new version, or run on Linux Mint. M0.2–M0.3 remain open for the
two-release manual Mint check, including cancelled authorization and
package-manager failures. Do not treat the installed-package smoke as an
automatic update end-to-end test.

## Two-version AppImage portable replacement integration (M0.4)

The Linux CI workflow separately builds two unpublished AppImages,
`0.1.0-rc.9000` and `0.1.0-rc.9001`, from the same checkout. It launches
the older portable executable under Xvfb, checks the real AppImage runtime's
`APPIMAGE` path and verifies that the Electron process reports the correct
`appimage` updater type, version and preload/IPC state. It then replaces
the same portable executable path with the newer artifact, confirms its
SHA-256 changed, and performs the same packaged smoke checks against the new
version. Neither AppImage requires root privileges.

The GitHub-hosted runner uses the AppImage runtime's
`APPIMAGE_EXTRACT_AND_RUN=1` fallback to avoid requiring FUSE. This still
exercises the AppImage runtime and packaged application, **not** the real
`electron-updater` download, SHA-512 verification, installation handoff or
restart. Replacement happens only while the app is stopped. Both RC numbers
are test fixtures, not published releases. Manual AppImage-to-AppImage
updater QA remains mandatory before closing M0.4.

## Two-version Windows NSIS upgrade integration (M0.4)

The Windows CI workflow builds two **unpublished** `0.1.0-rc.9000` and
`0.1.0-rc.9001` NSIS installers from the same source commit. It runs each
installer silently (`/S`) into the same test directory on an ephemeral
GitHub-hosted Windows runner. After each installation it launches the
packaged `spindle.exe` in smoke mode, which verifies the sandboxed preload,
IPC, the NSIS updater identity, and the running Electron app version. The
running application emits a test-only result file after those assertions
pass, so Windows GUI processes need not have attached stdout. The test also
checks the `app.asar` payload changed between versions.

This checks real NSIS installation and replacement. It does **not** exercise
GitHub Releases, the electron-updater download, permission prompts,
automatic restart, or interactive cancellation/failure recovery. The two RC
numbers are synthetic CI fixtures, never published or tagged. M0.4 remains
open until installed Windows and AppImage clients complete genuine updater
flows with two successive published release versions.

## Two-version Debian package upgrade integration (M0.3)

The additional Ubuntu CI job creates two **temporary, unpublished** DEB
installers from the checked-out commit, stamped `0.1.0-rc.9000` and
`0.1.0-rc.9001`. It installs the older build through APT, verifies that
its Electron app and the installed package agree, then exercises the
production `installVerifiedDeb` implementation against the new DEB:

- The installer validates package ownership, downloaded-file regularity,
  SHA-512, Debian package name/version and the final installed version.
- A simulated denied `pkexec` request must produce `package-manager`
  failure and leave the old package installed.
- For the successful integration path only, a CI adapter substitutes
  passwordless `sudo /usr/bin/dpkg --install` for the normal interactive
  `pkexec /usr/bin/dpkg --install`. The arguments and all other verification
  steps remain unchanged.
- The newly installed Electron executable is launched under Xvfb and must
  pass the packaged preload/IPC and real Debian ownership/version smoke.

These version numbers are **test fixtures**, not intended GitHub tags or
release candidates for users. The test does not contact GitHub, download via
electron-updater, exercise a real polkit authorization dialog, or prove that
Spindle relaunches automatically after an update. M0.2–M0.3 remain open
until the actual release-to-release update works on Linux Mint, including
the cancellation and restart paths.

## Linux DEB updater regression QA

When validating a new release from an older update-enabled build on Linux
Mint or another Debian-based distribution:

1. Install the old DEB, launch it from the desktop application menu.
2. Publish a newer RC and confirm the update offer and correct version.
3. Download and inspect progress. Confirm the pkexec password prompt.
4. Verify that a successful install changes the system `spindle` package
   version and that the restarted app also reports the new version.
5. Deliberately cancel the pkexec prompt: the app must remain open, show
   an installation error and not report success.
6. Launch an old unpacked copy: the updater must refuse to install a DEB
   over an unrelated executable.
7. Check the unchanged-version recovery dialog if a handoff fails.
8. Repeat the update on AppImage and Windows NSIS to check for regressions.

The DEB path runs `pkexec /usr/bin/dpkg --install <verified-file>` using
argument arrays, not shell commands. It verifies both the downloaded
SHA-512 digest and the installed dpkg version before relaunching.

## Debian updater preflight (M0.2)

Packaged Debian builds verify that the running executable belongs to the
installed `spindle` package and that `dpkg-query` reports the same version
as the running application. This runs **before checking GitHub**, before
download, and again before installation. A stale or unrelated launcher fails
closed, without fetching an installer or requesting elevation. A Debian RC
version such as `0.1.0~rc.8` matches Electron's `0.1.0-rc.8`.

CI tests mock `dpkg-query`; they do not establish real OS behavior. For
Linux Mint QA, record the running version, installed package version, active
launcher path, selected downloaded artifact type, elevated install result, and
version after restart. Cancel elevation and verify the old app stays open,
showing a failure. Use two real installed DEB releases, not an unpacked
Electron build. The new preflight must be verified on a future tagged build.

## Update diagnostics for QA (M0.5)

Open **Spindle updates** and choose **Copy diagnostics**. The clipboard
report includes only a fixed set of fields: operating system, installer type,
release channel, running/available versions, updater phase, failed operation,
error category, and timestamp of the last completed check. It excludes raw
exception messages, local executable paths, release URLs, authorization
headers and tokens. Raw electron-updater logging is disabled so authenticated
request details are not printed to the app's console. Attach that report and the **observed** installer version
to any updater regression report. Keep personal logs or authentication tokens
out of public issues.

The update dialog also shows whether the failure was during checking,
downloading or installation, and offers a link to GitHub Releases for a
manual installer recovery when automatic updates cannot complete.

A successful unit test or CI package build does not close M0.2–M0.5.
Record the OS, old and new tagged version, actual artifact type,
installer outcome and restart version for each native QA attempt.

## Release tag safety and transient GitHub API failures

**Tags must point to the current `main` commit.** The release workflow
checks the tag checkout against `refs/heads/main` before running any builds.
Creating a version tag from a stale local branch will fail with an actionable
message instead of publishing obsolete binaries.

For example, the `v0.1.0-rc.5` tag was created from an older commit before
the Linux DEB updater fixes on `main`. It also encountered an HTTP 500 in
GitHub's release publication API. Do **not** rerun or move that tag.
Use a new RC number from a freshly pulled `main`:

```bash
git switch main
git pull --ff-only
git rev-parse HEAD
git tag -a v0.1.0-rc.6 -m "Spindle v0.1.0-rc.6"
git push origin v0.1.0-rc.6
```

Publication now stages a **draft** release before uploading assets one by
one. It retries transient GitHub HTTP 429/5xx and connection failures, checks
remote asset names, sizes, and SHA-256 digests to resume after partial
success. An existing **published** release is never overwritten when asset
bytes differ. It makes the release public **only** when every required
installer, update manifest, and checksum file has the expected digest. It excludes electron-builder debug metadata from
public downloads.

A failed publication leaves the draft with any successfully uploaded assets.
A rerun on the **same valid tag** can resume the publication, provided the
release tag still passes the main-head safety check. Do not rerun old tags
after the repository has advanced.

## Important: rc.4 to rc.5 installation

The `v0.1.0-rc.4` tag points to the commit before the custom Debian
installer was merged. It uses the upstream DebUpdater which may invoke
`dpkg -i` on a downloaded AppImage followed by `apt-get install -f`.
The fix included in rc.5 cannot change the updater inside the running rc.4
binary. Install rc.5 (or a newer RC) using the downloaded `.deb` manually
as a one-time recovery. A later update can then exercise the corrected code.

The updater now rejects a downloaded AppImage at the **download-complete**
boundary for DEB installs. It never presents an invalid package as ready,
and never elevates the installer for it.

## Release format selection before download

For a package installed through `.deb`, Spindle uses a strict `DebUpdater`
that filters GitHub's mixed `latest-linux.yml` metadata **before any
download starts**. It accepts exactly one matching
`Spindle-VERSION-linux-x64.deb` entry with valid SHA-512 and passes only
that entry to electron-updater. Missing or ambiguous Debian assets produce
an error; the client cannot fall back to an AppImage.

AppImage and Windows NSIS clients retain their respective updater
implementations. Debian detection uses electron-builder's packaged
`resources/package-type` marker; an unknown Linux package type has
auto-updating disabled instead of guessing. This works for stable and
`-rc.N` releases without depending on custom GitHub channel names.

## Publication integrity and next RC validation

The release publisher reads GitHub's REST release asset metadata, which
provides immutable upload-time SHA-256 digests. Reruns compare every expected
asset by filename, size, and digest; matching published releases are no-ops.
A digest mismatch on a **draft** can be repaired with a resumable re-upload.
A mismatch on a **published** release stops with an error rather than
silently replacing a published installer. Permission failures (403) are not
mistaken for a missing release (404).

PR CI validates the GitHub Actions workflow definitions with actionlint so
release-only workflow syntax problems can be detected before a tag push.

The `v0.1.0-rc.6` workflow failed before any build or publication jobs ran;
GitHub's Jobs API exposes only skipped downstream jobs, not a failing
validation step. The exact cause was not established by the available logs.
Do not move or reuse that tag.

On November 4, 2026, `v0.1.0-rc.7` **successfully** passed tag validation,
both platform builds and GitHub Release publication. GitHub lists the
Linux DEB/AppImage, Windows NSIS installer, both updater manifests,
`SHA256SUMS.txt`, and the Windows blockmap with upload-time SHA-256 digests.
This verifies that the prior publishing workflow can complete. The new
digest-matching publisher should be exercised with a subsequent fresh RC
tag after its PR is merged. Always tag the current `main` commit; never
reuse or force-move old release tags.
