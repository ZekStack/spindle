# Spindle — Product and engineering roadmap

Spindle is an **open-source, GitHub-first desktop application** for managing
organizations, repositories, local Git workspaces, tags, releases, and GitHub
Actions. It must be useful for **any** GitHub user or organization, without
hardcoded repository inventories or organization-specific workflows.

**Platforms:** Linux (Debian/Ubuntu/Mint DEB and AppImage), Windows (NSIS).
**Stack:** Electron, React, TypeScript, Vite, Tailwind/shadcn, TanStack
Router/Query, pnpm. English and Hungarian, dark/light appearance.

This is the **single source of truth** for delivery. Work through milestones
in order, but implement each numbered slice as a focused, reviewable PR.
Update the corresponding checkbox and any new findings **in the same PR**
that implements a slice. Do not mark a feature done merely because it
compiles: the milestone's acceptance gate must also pass.

## Starting point

**Already implemented (foundation):**
- [x] Electron main/preload/renderer, typed IPC, main-frame validation and local preferences.
- [x] Organization add/remove, repository discovery and tracking, read-only
      Releases and GitHub Actions run views.
- [x] Initial `gh` / environment-token / anonymous authentication fallback.
- [x] Orange/charcoal design, HU/EN translations, light/dark mode.
- [x] Linux DEB/AppImage and Windows NSIS packaging in GitHub Actions, tag
      releases including `-rc.N`, update metadata and checksums.
- [x] Update offer, manual download/install confirmation and progress UI.
- [x] Code paths for validated Debian install/version checks and strict
      pre-download DEB artifact selection.
- [x] Release publishing retry/resume logic and automated error-path tests.

**Not yet validated:** a full automatic update from one updater-enabled
installed DEB to the next on Linux Mint; AppImage/Windows installer upgrades
on real machines; recovery from a real failed GitHub Release publication.
The current product is still largely **read-only**. Do not call these gates
complete until tested. Track the first blocked gate in M0, not as a new
feature elsewhere.

## Milestone overview

| Order | Milestone | Result | Priority |
| --- | --- | --- | --- |
| M0 | Trusted builds, releases and updates | A release can be installed and safely upgraded | **P0 — active** |
| M1 | Accounts and repository onboarding | Any GitHub user can configure their repositories | P1 |
| M2 | Job engine and Activity | Long-running operations are observable and recoverable | P1 |
| M3 | Local Git workspaces | Clone, fetch, pull and inspect repositories | P1 |
| M4 | Tags and GitHub Releases | Complete, safe release lifecycle | P1 |
| M5 | GitHub Actions | Run, inspect and manage workflows | P1 |
| M6 | Product UX and diagnostics | Coherent cross-org daily workflow | P2 |
| M7 | Public distribution and 1.0 readiness | Secure, tested and documented desktop release | P2 |

Milestones define **capability gates**, not release numbers or deadlines.
The project may ship release candidates during any milestone.

## M0 — Trusted builds, releases and updates

**Goal:** do not build remote-mutation features on top of an updater or
release pipeline that leaves users on the wrong version.

- [x] **M0.1 — Release publication end-to-end.** Review the latest failed
      tag-run diagnostics; ensure a tag from the intended commit validates,
      Linux/Windows builders pass, checksums and both update manifests are
      uploaded, and the GitHub Release becomes visible. Test transient upload
      failures/resume without moving existing tags.
      Engineering work completed: [x] SHA-256 digest matching of all release
      assets instead of trusting size alone; [x] explicit 404-versus-403/5xx
      release lookup; [x] fail-safe behavior for already-published assets;
      [x] GitHub Actions workflow lint in CI. **Runtime gate passed**:
      `v0.1.0-rc.8` completed on the merged main commit with all expected
      published assets and SHA-256 digests; transient failures are covered
      by automated recovery tests.
- [ ] **M0.2 — Debian format selection.** On an installed Mint/Ubuntu DEB,
      inspect the running package type, confirm the network download is
      `.deb` (never `.AppImage`), and confirm it matches the release SHA-512.
      Reject missing/ambiguous metadata **before** download or elevation.
      Engineering work: [x] strict pre-download DEB selection; [x] fail-closed
      running executable ownership and version preflight before update checks,
      downloads and installation; [x] CI installs the generated DEB on a
      GitHub-hosted Ubuntu runner and smokes packaged updater identity,
      dpkg ownership, version equality, preload and typed IPC; [x] release
      pipeline installs and smoke-tests the exact tagged DEB before publish;
      [x] a dedicated Ubuntu CI job installs a synthetic older RC and uses
      the production updater over the public GitHub feed to download the
      latest published DEB, checking the ready state without elevation.
      **Real Linux Mint update/install/restart QA remains open.**
- [ ] **M0.3 — Debian install and restart.** Test a real **new RC → newer
      RC** update: single authorization, package-manager success, expected
      `dpkg-query` version, restart into the newly installed binary. Cancel
      authorization and force an install error: no false success, no restart,
      and no infinite repeated update offer.
      Engineering work: [x] automated Debian upgrade integration builds two
      unpublished RC packages from the same commit, installs the older
      package, exercises `installVerifiedDeb` against the newer package with
      its real SHA-512/package metadata, simulates cancelled elevation, and
      smoke-tests the installed executable before and after. **Real user
      updater download, pkexec prompt, relaunch, and Linux Mint QA remain open.**
- [ ] **M0.4 — Other platform upgrades.** Test AppImage → AppImage on Linux
      and NSIS → NSIS on Windows with the same newer-version, progress,
      cancel/error, restart, and package-identity expectations.
      Engineering work: [x] Windows CI builds two unpublished NSIS RC
      installers, silently installs each sequentially on the same runner,
      verifies the packaged updater identity/version via Electron preload/IPC,
      and checks the installed payload changes; [x] Linux CI builds two
      unpublished AppImages, launches each with its real runtime and portable
      executable path, verifies the running updater identity/version/IPC, and
      checks executable replacement; [x] the release pipeline also launches
      the tagged AppImage and installs/launches the tagged NSIS package on
      native runners before publish. **Real electron-updater download/restart,
      user consent/cancel, and published-release QA remain open.**
- [ ] **M0.5 — Channel/diagnostic QA.** Stable installations must ignore RCs;
      RC installations may advance to newer RCs and stable builds. Keep
      credentials out of logs and renderer errors; provide useful diagnostic
      context and a manual download fallback.
      Engineering work: [x] release-version policy tests; [x] allowlisted
      update diagnostic report containing installer type, channel, last
      failure phase and category; [x] trusted IPC clipboard action; [x]
      existing manual GitHub Releases fallback; [x] disable upstream updater
      logging to prevent credential-bearing requests entering raw logs.
      **Packaged channel/error QA
      remains open** for Linux and Windows.

**Exit gate:** the *packaged* application completes a two-version upgrade on
each supported installer type; failed installation never reports success;
Linux and Windows CI and the publish workflow are green. Record tested
version pairs, OS, installer type, and outcome in the PR/release notes.

## M1 — Accounts and repository onboarding

**Goal:** a new user can configure Spindle without cloning our repositories
or editing a shell script.

- [ ] **M1.1 — Identity.** Show current account, permissions and authentication
      failures. Keep existing GitHub CLI auth working; design optional
      first-party GitHub OAuth device-flow sign-in with a configurable
      application client ID (no bundled secrets) and logout.
- [ ] **M1.2 — Credential security.** Store app-managed credentials using
      supported OS facilities; handle token expiration, revocation and
      permission scopes. Never expose tokens via renderer IPC, logs or Git.
- [ ] **M1.3 — Repository onboarding.** Add/remove organizations and
      individual repositories, including personal repositories, via search
      and pickers. Distinguish untracking locally from modifying GitHub.
- [ ] **M1.4 — Discovery quality.** Pagination, search, private/archived
      indicators, accessible-org discovery and helpful 401/403/404/rate-limit
      states. Support multiple unrelated organizations at once.

**Exit gate:** a fresh user can authenticate, add any accessible
organization or repository, restart Spindle, and retain the workspace.
Read-only browsing works without a token for public repositories.

## M2 — Main-process job engine and Activity

**Goal:** operations must continue when dialogs close and communicate their
real status rather than showing a spinner indefinitely.

- [ ] **M2.1 — Typed operation model.** Define job ID, kind, repository,
      requested action, timestamps, phase, progress, output and structured
      error codes. Renderer talks to narrowly scoped preload IPC methods.
- [ ] **M2.2 — Execution lifecycle.** Main-process scheduler with
      concurrency limits, one mutating job per repository, cancellation,
      timeouts, stream output, and safe child-process cleanup.
- [ ] **M2.3 — Durable Activity dialog.** Header-triggered shadcn dialog
      with running/history filters, job detail, live output, and reopen
      behavior. Persist a compact history and mark interrupted jobs
      accurately after application restart.
- [ ] **M2.4 — Reliability and security.** Explicit retryability and
      partial-completion states, sanitized logs, no shell interpolation,
      and deterministic tests for cancel/restart/timeout failures.

**Exit gate:** a simulated long-running job continues with the Activity
dialog closed, can be cancelled safely, and retains a meaningful final
state after a process restart.

## M3 — Local Git workspaces

**Goal:** manage real local checkouts on Linux and Windows.

- [ ] **M3.1 — Workspaces.** Native directory picker, multiple workspace
      roots, editable repository locations, local repository detection and
      Git executable discovery. No fixed directory layout.
- [ ] **M3.2 — Clone and sync.** Clone, fetch and pull with streamed progress;
      default pull policy is fast-forward-only. Verify origin URL, branch
      and missing/upstream state before modification.
- [ ] **M3.3 — Inspection.** Branch, commit, ahead/behind, dirty working
      tree, staged/untracked changes and local/remote tag inventory.
- [ ] **M3.4 — Safety.** Refuse destructive operations when the worktree
      is dirty unless the user explicitly chooses a supported safe action.
      Handle detached HEAD, conflicts, authentication and network failures.

**Exit gate:** clone an arbitrary public/private repository to a user-chosen
folder, fetch/pull it, and accurately show local versus remote state.
The same workflow passes on Windows and Linux.

## M4 — Tags and GitHub Releases

**Goal:** manage releases without confusing a local tag, remote tag, GitHub
Release, and CI-generated release workflow.

- [ ] **M4.1 — Tag lifecycle.** Create annotated/lightweight local tags,
      push a selected tag, show remote state, and delete **local and origin
      independently**, including a clear combined operation. Confirm remote
      deletion and never move published tags implicitly.
- [ ] **M4.2 — Release lifecycle.** Create draft releases from an existing
      tag, edit notes, publish/prerelease, upload assets, and remove a
      Release separately from its tag. Show exact commit SHA and status.
- [ ] **M4.3 — Release strategies.** Per-repository configuration for
      **tag-push workflow**, **workflow_dispatch**, or **GitHub API** release
      creation; discover defaults rather than hardcoding workflow names.
- [ ] **M4.4 — Safe progress.** Correlate tag/commit, Actions run, publication
      and assets. Handle eventual consistency with bounded polling and
      explicit unknown/failed/timed-out states; recover from partial success
      without duplicate tags/releases.

**Exit gate:** create, publish, inspect and remove a release in a test
repository using both a tag-driven and direct/manual strategy. Every
destructive choice has a confirmation and an auditable result.

## M5 — GitHub Actions management

**Goal:** observe and control the actual release workflows from Spindle.

- [ ] **M5.1 — Workflow discovery.** List workflow files, triggers,
      dispatch inputs, recent runs, branches, commits and permissions,
      including pagination and filtering.
- [ ] **M5.2 — Controls.** Dispatch manual workflows, cancel, rerun and
      rerun failed jobs with clear permissions and confirmations.
- [ ] **M5.3 — Live detail.** Run/job/step state, streaming or bounded
      log refresh, failures, artifacts and downloads; show polling backoff
      and GitHub rate-limit feedback.
- [ ] **M5.4 — Release linkage.** Link a tag operation to its actual
      run and published GitHub Release; no infinite `Waiting for workflow`
      state when GitHub cannot correlate a run.

**Exit gate:** dispatch an arbitrary workflow, watch it complete, inspect
failure logs, and rerun a failed job from the application.

## M6 — Product UX and diagnostics

**Goal:** reduce repeated command-line and browser switching.

- [ ] **M6.1 — Unified workspace.** Search/filter/sort across organizations
      and tracked repositories; useful states, badges and quick actions.
- [ ] **M6.2 — Action UX.** Consistent shadcn dialogs, review/confirm
      screens, keyboard navigation, tooltips, responsive layout, and
      predictable empty/loading/error states; no unnecessary permanent sidebar.
- [ ] **M6.3 — Preferences.** Clearly organized settings for workspace,
      account, theme, language, update channel and optional release profiles.
- [ ] **M6.4 — Diagnostics.** Export sanitized logs and operation history,
      display actionable permission/network/Git errors, and test English
      and Hungarian UI parity.

**Exit gate:** frequent workflows are discoverable, the application
handles empty/offline/error states cleanly, and keyboard-only navigation
is usable on Linux and Windows.

## M7 — Public distribution and 1.0 readiness

- [ ] **M7.1 — Security audit.** Validate all privileged IPC handlers,
      Git URL/path inputs, GitHub scopes, credential storage, execution,
      secrets in errors, and destructive-action confirmation.
- [ ] **M7.2 — Release trust.** Code-signing strategy for Windows,
      update-manifest integrity/provenance, reproducible dependency locking,
      checksum verification and retained release assets.
- [ ] **M7.3 — Platform QA.** Install, launch, upgrade, uninstall and
      recover on supported Windows and Linux distributions. Test RC and
      stable channels with real downloaded installers.
- [ ] **M7.4 — Open-source onboarding.** Generic screenshots, quickstart,
      configuration examples, permissions guide, troubleshooting,
      contribution and security policies; no internal organization
      assumptions or bundled credentials.

**Exit gate:** a new contributor can build it; a new user can install and
operate it without project-specific scripts; both supported platforms have
passing release/update validation.

## Delivery rules

1. **One focused PR per numbered slice** (or split a slice if it grows too
   large). Keep source modules small and testable; do not build a general
   abstraction before a real use case needs it.
2. **Update this roadmap in each implementation PR.** Mark a checkbox only
   when its tests **and** required user-facing verification pass. Move
   unresolved issues into the same milestone.
3. **CI:** `pnpm install --frozen-lockfile`, typecheck, tests and build on
   Linux/Windows. Require real package smoke tests for packaging changes.
4. **Safety:** Git operations stay in Electron main, use argument-array
   execution (never shell interpolation), and maintain explicit IPC
   validation. Remote mutations require intentional user confirmation,
   appropriate GitHub permissions and clear failure/partial-success states.
5. **Compatibility:** do not break existing local workspace preferences or
   previously shipped installer/update paths without an explicit migration
   or recovery procedure.
6. **Do not merge on green CI alone** when a stage requires a real GitHub or
   OS-level action; record a short manual QA matrix with results.

**Latest validation:** `v0.1.0-rc.8` on November 4, 2026 passed
[Release workflow #41831312133](https://github.com/ZekStack/spindle/actions/runs/41831312133),
built native Linux and Windows installers, and published all expected
release assets (including updater manifests, checksums and SHA-256 upload
digests). This confirms the digest-aware publisher introduced in PR #8.
The preceding `rc.7` publication had succeeded with the older publisher.
No real Mint, AppImage or NSIS upgrade has been verified yet.

**Next M0 acceptance action:** use the guarded, manually dispatched
**Prepare RC** workflow to publish `v0.1.0-rc.9` from a green main commit,
verify the tag-specific native smoke gates, and install that build on real
Linux Mint/Windows machines. After recording the installed versions, publish
`v0.1.0-rc.10` from green main and test the real in-application RC-to-RC
download, authorization, failure/cancellation and restart on Linux Mint DEB,
AppImage and Windows NSIS. The manual workflow automates safe tag creation
and release dispatch, **not** OS-level QA. No native two-release upgrade is
yet verified. Do not begin M1 before the M0 installation gates pass.
