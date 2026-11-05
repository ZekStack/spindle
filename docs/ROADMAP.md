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

**Product feature implementation is now proceeding at user request while
M0's real installed-update acceptance remains open.** This does not close
M0 release gates or certify the updater for public production deployment.

- [x] **M1.1 — Identity.** The header now opens an account dialog with
      live GitHub viewer information, credential source, reported OAuth
      scopes and distinct invalid/forbidden/rate-limited/offline states.
      Explicit refresh detects updated GitHub CLI credentials without
      changing shared machine-wide tokens. First-party sign-in and isolated
      sign-out are now available as the separate M1.2 implementation.
      Scopes are not represented as repository permissions.
- [ ] **M1.2 — Credential security.** [x] Implemented: interactive GitHub
      OAuth device authorization with user code, configured public client ID,
      approval polling/cancel and session expiry; [x] OS-backed asynchronous
      safeStorage encryption with a hard rejection of Linux basic_text and
      missing keyring; [x] persisted app-only token integrated with GitHub
      requests and updates; [x] multi-account OS-encrypted vault with
      active-login switching, external credential selection, and isolated
      per-account removal/sign-out without changing GH_TOKEN or gh CLI;
      [x] sanitized permission-scope, invalid/revoked-token and error states.
      **Remaining acceptance:** a real GitHub OAuth App device authorization
      on Windows and Linux Mint, including encrypted persistence after restart,
      keyring-unavailable behavior and local sign-out. Remote revocation is
      explicitly a GitHub account operation, not implied by local sign-out.
      Never expose tokens through IPC, logs or Git.
- [x] **M1 UX — Workspace-first dashboard.** Removed the centered marketing
      hero, expanded desktop content to usable viewport width, and added
      local tracked-repository shortcuts, organization browsing and search.
      Preserve empty states without invented metrics or marketing content.
- [x] **M1.3 — Repository onboarding.** Users can search GitHub
      organizations in the add-organization dialog, or add them by login;
      search accessible repositories by name, or directly enter any
      `owner/repository` (including personal and private repositories with
      appropriate credentials). Repository tracking no longer requires an
      organization, and local untracking is available on workspace/repository
      screens. Removing an organization preserves independent tracked
      shortcuts. All operations are local preferences; GitHub resources are
      never changed. Pagination/discovery refinements continue in M1.4.
- [x] **M1.4 — Discovery quality.** The add-organization dialog now lists
      organizations available to the selected GitHub account (with a separate
      public search option). Organization repository search runs across all
      accessible repositories server-side rather than filtering only one
      loaded page. GitHub Link pagination and Search result totals control
      Next/Previous navigation; private/archived markers remain visible.
      Distinct 401, 403, 404, rate-limit, offline and service-error states
      provide actionable English/Hungarian messaging without exposing tokens.
      Multiple unrelated saved organizations continue to coexist.
      **Acceptance still requires** real-account discovery and private-org
      browsing on installed desktop builds.

**Exit gate:** a fresh user can authenticate, add any accessible
organization or repository, restart Spindle, and retain the workspace.
Read-only browsing works without a token for public repositories.

## M2 — Main-process job engine and Activity

**Goal:** operations must continue when dialogs close and communicate their
real status rather than showing a spinner indefinitely.

- [x] **M2.1 — Typed operation model.** Defined validated job IDs,
      repository, action/kind, start/end times, queued/running/terminal phases,
      progress, bounded output and structured safe error codes. The typed
      preload IPC exposes only job list, repository inspection and cancel,
      plus live updates. The first real operation inspects repository
      metadata, releases and workflow runs from Electron main.
- [ ] **M2.2 — Execution lifecycle.** The main-process queue supports two
      concurrent read-only repository inspections, bounded queue size,
      per-repository deduplication, cancellation via AbortSignal, 45-second
      deadlines and live progress. [x] Activity now supports a native folder
      picker and a real, serialized local Git inspection job; [x] child
      processes use fixed argument arrays with no shell, disabled prompts,
      bounded stdout/stderr and process termination on cancel/timeout;
      [x] branch and staged/modified/untracked counts are reported without
      persisting raw filenames, URLs or command output; [x] local inspection
      retries use previously selected paths, not arbitrary renderer paths.
      **Remaining:** installed desktop QA for cancellation/process cleanup
      on Linux and Windows, and transaction-aware serialization of future
      mutating clone/fetch/pull operations when M3 adds those commands.
- [ ] **M2.3 — Durable Activity dialog.** Implemented header-triggered
      Radix/shadcn Activity with running/history filters, job details,
      safe output, cancellation/retry and real-time event updates. The
      main-process history persists the latest 100 operations in an atomic
      user-data file, detects corrupted history without overwriting it,
      and marks previously running jobs interrupted after restart.
      **Remaining acceptance:** manual Linux/Windows inspection, dialog
      close/reopen, cancellation and restart QA on installed builds.
- [ ] **M2.4 — Reliability and security.** [x] Activity distinguishes
      partially completed operations from total failure without losing
      successful inspection steps; [x] typed retryability separates
      temporary network/rate-limit/timeout errors from permission,
      missing-Git and invalid-repository failures; [x] sanitized
      operation output and clear localized retry guidance;
      [x] Git child processes run without a shell, use process-group
      termination on Linux, escalate stalled cancellation and bound output;
      [x] focused partial-result, permission-failure, cancellation and
      restart-history regression checks. Existing activity history remains
      readable without migration. **Remaining acceptance:** real Linux
      Mint and Windows tests for cancellation/process cleanup and recovery
      with installed builds.

**Exit gate:** a simulated long-running job continues with the Activity
dialog closed, can be cancelled safely, and retains a meaningful final
state after a process restart.

## M3 — Local Git workspaces

**Goal:** manage real local checkouts on Linux and Windows.

- [ ] **M3.1 — Workspaces.** [x] Native directory picker, Git executable
      discovery and read-only checkout detection from Activity (M2.2);
      [x] persist multiple user-selected workspace roots independently of
      GitHub preferences; [x] associate individual GitHub repositories with
      existing local worktrees using an explicitly selected folder and an
      exact, credential-free GitHub origin check; [x] change/unlink locations
      without moving or deleting files; [x] treat missing directories and
      corrupted settings as explicit failures, never silently reassign;
      [x] Linux/Windows test fixtures for case-insensitive repository keys,
      Git remotes, nested folders, symlinks and persistence.
      **Remaining acceptance:** installed Linux Mint/Windows folder-picker,
      persistence/restart, Git unavailable, moved-worktree and relink QA.
      No fixed workspace directory layout; no automatic clone or fetch.
- [ ] **M3.2 — Clone and sync.** Clone, fetch and pull with streamed progress;
      default pull policy is fast-forward-only. Verify origin URL, branch
      and missing/upstream state before modification.
      Engineering work: [x] clone into an explicitly saved workspace root with
      destination collision prevention and automatic origin-verified linking;
      [x] fetch and fast-forward-only pull from linked GitHub checkouts;
      [x] main-process-only Git execution with streaming allowlisted progress,
      bounded Activity jobs, cancellation and safe history;
      [x] reject changed origins, detached HEAD, missing/mismatched upstream,
      and dirty pull worktrees; [x] synthetic local Git remote regression tests.
      **Remaining acceptance:** real private repository credentials via the
      configured system Git client; native Windows/Linux clone, fetch and
      pull QA, large clone cancellation and interrupted-directory recovery.
      Do not mark this slice complete until these platform gates pass.
- [ ] **M3.3 — Inspection.** Branch, commit, ahead/behind, dirty working
      tree, staged/untracked changes and local/remote tag inventory.
      Engineering work: [x] bounded local Git snapshot in the existing
      cancellable Activity job, persisted without raw filenames, Git stderr
      or remote URLs; [x] branch/HEAD SHA and upstream divergence with explicit
      no-upstream and detached/unborn states; [x] NUL-delimited porcelain
      parsing for staged, modified, untracked, renamed and conflicted files;
      [x] local tag inventory and live remote tag inventory for verified linked
      GitHub origins only (distinguishing unavailable from empty remote);
      [x] structured repository overview and Activity details with HU/EN
      text, totals, 40-tag display cap and explicit refresh; [x] synthetic
      read-only Git inspection tests on Linux/Windows CI.
      **Remaining acceptance:** installed Linux Mint and Windows checkouts,
      private remote access, offline/large tag lists, detached HEAD and
      branch divergence QA. Counts reflect the last local and remote-tracking
      refs; inspection does not implicitly fetch, and the remote tag query
      does not update those refs.
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

**Latest release validation:** `v0.1.0-rc.8` passed [Release workflow
#41831312133](https://github.com/ZekStack/spindle/actions/runs/41831312133)
on November 4, 2026. More recently, the stable `v0.1.1` and
`v0.1.2` releases were published on November 5; `v0.1.2` passed
[Release workflow #42003253518](https://github.com/ZekStack/spindle/actions/runs/42003253518).
Publication proves the native tagged package-smoke gates; it does **not**
prove a real interactive update between installed versions.

**Next M0 acceptance action:** on real Linux Mint/Ubuntu DEB, AppImage and
Windows NSIS installs, exercise the app's updater with an installed
`v0.1.1 → v0.1.2` pair (or another two successive published builds
with the same updater path). Record the exact starting and target versions,
selected installer asset, checksum verification, user consent/cancellation,
failed-install handling, installed version and relaunch. Test channel
behavior against RC and stable feeds as described in M0.5. Do not label
M0.2–M0.5 complete based on release CI alone. M1/M2 feature development
is proceeding at user direction, but **M0 release acceptance remains open**
before certifying public distribution.
