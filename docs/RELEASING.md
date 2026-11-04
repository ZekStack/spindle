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
`contents: write`. It checks for an existing release on rerun and replaces
its uploaded assets without moving or recreating the git tag. Replacing assets
is incompatible with immutable releases; where immutability is enabled,
publish a new version rather than trying to replace a released artifact.

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
