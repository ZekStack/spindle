# Spindle

A cross-platform desktop workspace for GitHub organizations, repositories,
releases and GitHub Actions — developed by [ZekStack](https://github.com/ZekStack).

Spindle brings repositories, releases, and GitHub Actions from multiple
GitHub organizations into one desktop workspace. Add the organizations and
repositories you want to follow without a predefined catalog.

> **Status: R1 foundation (early development).** The UI can currently discover,
> track and inspect repositories, releases and workflow runs. It does **not yet**
> create tags, publish releases, dispatch workflows or run local Git commands.

## Stack

- Electron 45, React 19, Vite 8 and TypeScript
- TanStack Router and Query
- Tailwind CSS 4 and shadcn-style Radix primitives
- Hungarian and English translations, light/dark theme
- pnpm, Linux and Windows packaging through electron-builder

## Run locally

Requirements: Node.js 22.12+, pnpm 10.20.0 and a network connection.
GitHub CLI is optional for public repositories; for private repositories
authenticate using `gh auth login` or set `GH_TOKEN` / `GITHUB_TOKEN`
**in the launching process**, not in the renderer.

```bash
corepack enable
corepack prepare pnpm@10.20.0 --activate
pnpm install
pnpm dev
```

Other commands: `pnpm typecheck`, `pnpm test`, `pnpm build`,
`pnpm pack:dir`, `pnpm pack:linux`, `pnpm pack:win`.
Native packages should be built and tested on their respective target OS.

The pnpm lockfile is committed and CI uses `pnpm install --frozen-lockfile`.
The Windows and Linux builds are checked in CI, including a Linux Electron
preload/IPC smoke test. Linux CI also installs the generated DEB on an
ephemeral Ubuntu runner and verifies package ownership, version and updater
identity through the packaged application. A separate Ubuntu integration job
also builds two unpublished RC packages and exercises the verified Debian
installer against real dpkg state, including simulated authorization denial.
A dedicated Ubuntu job also exercises the real public GitHub update feed and
downloads a published Debian update through the packaged application's IPC,
without installing it or claiming to validate the restart flow.
Windows CI likewise builds and silently installs two NSIS versions in
sequence, checking the packaged updater/IPC identity and changed application
payload. Another Ubuntu job launches two real AppImage builds and checks
portable replacement, updater identity, running version and IPC.
Two-version automatic update testing on Linux Mint, AppImage and Windows
still requires human desktop QA.

## First-use workflow

1. Open Spindle and add a GitHub organization by its login name.
2. Browse its accessible repositories. Private repositories require sufficient
   GitHub access; anonymous browsing is limited to public resources.
3. Star repositories to track them in your local workspace.
4. Open a repository to inspect its metadata, recent Releases and Actions runs.

Adding or removing an organization in Spindle only changes local preferences;
it does not modify GitHub organizations, memberships or repositories.

## Architecture and security

```text
React renderer (no Node integration)
   -> explicit window.spindle API
Sandboxed CommonJS preload (context isolation)
   -> fixed IPC channels, main-frame origin checks
Electron main process
   -> GitHub REST API (read-only in R1)
   -> atomic local JSON preferences in Electron userData
```

The renderer never receives credentials, filesystem access, or a generic
IPC bridge. GitHub requests use a fixed API origin, and external links are
restricted to `https://github.com`. Local preferences are stored in the
OS application data directory, not committed to the repository.

**Authentication:** Use the account dialog to sign in with GitHub
using a **GitHub OAuth application client ID** and GitHub's device code flow.
An OAuth app with device authorization enabled is required; enter its
public client ID in the dialog or provide `SPINDLE_GITHUB_CLIENT_ID`.
No client secret is packaged. The code appears in Spindle; approve it on
GitHub in the browser. The approved token is encrypted via the OS's
credential facilities and never exposed to the renderer.

Spindle-managed credentials take precedence over existing `GH_TOKEN` /
`GITHUB_TOKEN` and GitHub CLI tokens; otherwise it uses those external
credentials or anonymous public access. The account dialog shows the
active identity, reported OAuth scopes and credential failures. In-app
sign-out removes **only** the Spindle-managed credential, leaving shared
CLI and environment login untouched. Without a secure OS credential
backend—particularly on Linux where `basic_text` is unsafe—managed sign-in
is disabled. See [docs/AUTHENTICATION.md](docs/AUTHENTICATION.md) for
backend details, app setup and sign-out/revocation behavior. Do not
distribute PATs or package credentials with the application.

## Roadmap

See [docs/ROADMAP.md](docs/ROADMAP.md) for staged work and acceptance gates.

## Contributing

Spindle uses the MIT License. Open an issue or PR with a focused change and
tests. Keep organization identifiers and release workflows configurable,
avoid embedding secrets, and require an explicit confirmation for future
remote mutations.

## Downloadable releases

Releases are created by pushing a valid semantic version tag to GitHub.
Both stable tags (`v0.1.0`) and release candidates (`v0.1.0-rc.1`)
are supported. The suffix is embedded into the packaged app's version.
RC releases are GitHub prereleases and **do not supersede latest stable**.

The `Release` GitHub Actions workflow builds three **x64** packages on
native GitHub-hosted runners and publishes them only after all builds and
**native tagged-package smoke checks** pass (installed DEB, actual AppImage
runtime and installed NSIS). These gates do not substitute for complete
interactive updater QA:

| OS | Download |
| --- | --- |
| Debian / Ubuntu / Linux Mint | `Spindle-<version>-linux-x64.deb` |
| Linux (portable) | `Spindle-<version>-linux-x64.AppImage` |
| Windows | `Spindle-Setup-<version>-windows-x64.exe` |

Each release includes a `SHA256SUMS.txt` with checksums for all three
packages. GitHub Actions uses `contents: write` only in the publishing
job. Reruns resume incomplete draft uploads and verify asset SHA-256 digests; already published assets are never silently replaced.

```bash
git switch main
git pull --ff-only
git tag -a v0.1.0-rc.1 -m 'Spindle v0.1.0-rc.1'
git push origin v0.1.0-rc.1
```

For RC releases, **Actions → Prepare RC → Run workflow** provides a
guarded alternative to creating/pushing the tag manually. Select `main`
and enter an unused RC tag such as `v0.1.0-rc.9`. It requires green CI on
the exact main commit, refuses stale/reused/non-monotonic tags, then creates
the annotated tag and explicitly dispatches the Release workflow.
This is an **opt-in** operation; merging a PR never publishes a release.
If a tag already exists after a failed dispatch, manually run the Release
workflow on that tag instead of moving or recreating it.

After the workflows succeed, download the packages from
[GitHub Releases](https://github.com/ZekStack/spindle/releases).
AppImage users should run `chmod +x Spindle-*.AppImage` before launch.
These early builds are **not code signed**. Windows SmartScreen may warn,
and the installers still require desktop QA prior to public promotion.

See [release procedure](docs/RELEASING.md) for validation and RC rules.

## Desktop auto-updates (from the next tagged release)

When Spindle launches from an installed Windows NSIS, Linux AppImage or Linux
Debian package, it checks GitHub Releases for updates. If a newer compatible
release is available, a dialog offers **Download**, followed by **Install and
restart** when the verified download completes. Download progress and errors are
visible. There are no silent downloads or installs.

Stable versions receive only newer stable releases. Users running RC builds
receive newer release candidates and final releases, without downgrading.
Spindle also provides a **Check for updates** action in its header.
The update dialog can copy an allowlisted, credential-free diagnostic
report for troubleshooting. Failures identify the update stage and installer
format; the GitHub Releases link remains available for manual recovery.

Updaters use release metadata (`latest.yml`, `latest-linux.yml`, etc.) and
verify the downloaded artifact against the recorded SHA-512 checksum. The
tag-triggered release pipeline publishes these files alongside the existing
`.deb`, `.AppImage`, and `.exe` packages.

The repository is **currently private**. On installed machines, Spindle
reads existing `gh auth token` credentials or `GH_TOKEN`/`GITHUB_TOKEN`
from its launching environment, without embedding secrets in installers.
Private release access must be granted to the signed-in user. Public
releases can be checked without authentication after the repository is
published publicly.

**Important:** `v0.1.0-rc.1` was built before auto-updates existed, so it
must be upgraded manually once to an updater-enabled release. Desktop auto
updates work between later releases. The first update-enabled RC should be
tested on Windows, AppImage and installed `.deb` before public promotion.

On Debian-based Linux, updating an installed `.deb` may require
administrator authorization. Unsigned installers and update manifests are
currently verified using GitHub HTTPS and SHA-512 metadata; stronger signing
and provenance are planned before general public distribution.

## Linux Mint / Debian update installation

Spindle checks a downloaded DEB's published SHA-512 and verifies its
package name and version **before** invoking the system package manager.
With the new installation flow, the app waits for `pkexec dpkg --install`
to complete, verifies the installed package version with `dpkg-query`,
and only then relaunches. If elevation is cancelled or the package manager
fails, Spindle remains open and shows an actionable error instead of
restarting an unchanged version.

Spindle also records an update handoff. If it starts with the old version
after an attempted update, the next launch reports the unsuccessful handoff
instead of automatically showing the same update offer again.

This only applies to Spindle installed from the `.deb` package. The
AppImage and Windows installer paths still use electron-updater's own
installation logic. Running an unpacked or different executable cannot
silently overwrite the installed system DEB.

If an old installed build keeps showing an update after restarting, check:

```bash
dpkg-query -W -f='${Version}\n' spindle
command -v spindle
readlink -f "$(command -v spindle)"
```

A newer `dpkg-query` version alongside an older running app usually means
a different copy (for example an old AppImage) is being launched. If the
system package is still old, download the new `.deb` from GitHub Releases
and install it using your graphical package installer or:

```bash
sudo apt install ./Spindle-VERSION-linux-x64.deb
```

The fix is shipped only in a **newer** release. A running older binary
cannot acquire the changed installer implementation retroactively.

### Release reliability

Release tags must point to the current `main` commit. After merging new
changes, update local `main` before creating the next version tag.
GitHub Releases are published as drafts first, with individual resumable
uploads and retries for transient GitHub API failures. A failed upload never
makes an incomplete new release public. See [release procedure](docs/RELEASING.md).
