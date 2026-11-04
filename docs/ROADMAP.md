# Spindle implementation roadmap

Spindle is an open-source, provider-neutral-in-branding, **GitHub-first** desktop manager.
The app runs on Windows and Linux. No organization, username, repository or workflow is hardcoded.

## R1 — Desktop foundation (this PR)

- [x] Electron main/preload/renderer with React, Vite 8, pnpm
- [x] Restricted typed IPC and main-frame sender verification
- [x] Main-process GitHub REST client with optional existing `gh` authentication
- [x] Local workspace preferences stored outside the Git repository
- [x] Add/remove organizations and browse all accessible organization repositories
- [x] Track/untrack repositories, browse recent Releases and workflow runs
- [x] Orange/charcoal design, light/dark themes, Hungarian/English
- [x] TanStack Router/Query foundation
- [x] Unit tests, Windows/Linux CI jobs, packaging configuration
- [x] Generate and commit `pnpm-lock.yaml`; use frozen CI installation
- [ ] Verify Electron packaged GUI on both Windows and Linux (Linux preload/IPC smoke in CI)
- [x] Generate orange/charcoal Linux PNG and Windows ICO icons for packaging

## R2 — GitHub identity and organization UX

- [ ] First-class GitHub App device-flow sign-in (registration, OAuth permissions, token expiry/refresh)
- [ ] Secure credential storage with native OS facilities
- [ ] Discover memberships and personal repositories; access and permission diagnostics
- [ ] Repository collections, favorites, filters, organization logos and search
- [ ] Pagination beyond first page for Releases and workflow runs

## R3 — Local workspaces and Git

- [ ] Native folder picker and multiple independent workspaces
- [ ] Git binary discovery, status, branches and remotes
- [ ] Clone, fetch, pull (ff-only default), checkout and tagging, with cancellable jobs
- [ ] Clean-working-tree safety checks and origin verification
- [ ] Live per-job output and error diagnostics

## R4 — Tags and Releases

- [ ] Local/remote tag create/push/delete with explicit independent choices
- [ ] Draft/publish/edit/delete GitHub releases and release assets
- [ ] Workflow-based release profiles (push tag, workflow_dispatch, direct API)
- [ ] Verified correlation of tag, commit, Actions run and GitHub release
- [ ] Release notes editing, confirmation and recoverable operations

## R5 — GitHub Actions

- [ ] Browse workflow definitions and inputs
- [ ] Manual dispatch, cancellation, rerun and rerun failed jobs
- [ ] Live run/job/step status with log viewer and artifact downloads
- [ ] Action permissions, rate limits and failure states

## R6 — Durable activity

- [ ] Job queue, persisted operations and crash recovery
- [ ] Unified progress timeline across Git and GitHub
- [ ] Retry policies, backoff and polling based on API limits
- [ ] Desktop notifications, optional tray mode

## R7 — Open-source distribution

- [ ] Public documentation, onboarding, contribution guidelines
- [ ] Installer icons, signing strategy, Linux AppImage/deb and Windows NSIS
- [x] Tag-triggered Linux/Windows release workflow with SHA-256 checksums and RC prereleases
- [ ] Add signed builds and stronger release provenance/attestations
- [ ] Accessibility and keyboard-navigation QA
- [ ] Security audit and end-to-end packaged-app smoke tests

**Merge policy:** A stage is complete only with passing CI and, where applicable,
platform-specific runtime validation. Do not describe planned features as implemented.

## Desktop auto-updater

- [x] Check GitHub Releases on application launch with manual recheck
- [x] Opt-in download, progress, verified installer, explicit install/restart
- [x] Stable/RC version policy and HU/EN UI
- [x] Generate and publish updater metadata for Windows, AppImage and DEB
- [ ] Validate end-to-end update across two actual tagged releases on all three installer formats
- [ ] Sign update manifests/installers before public distribution

## Linux updater reliability

- [x] Wait for Debian system package installation to complete before relaunch
- [x] Confirm checksum, package identity and installed package version
- [x] Detect running an AppImage/unmanaged copy instead of the DEB installation
- [x] Remember failed update handoffs to prevent immediate repeated prompts
- [x] Translate installation failure modes and add regression tests
- [ ] Test the complete DEB update and cancellation on a Linux Mint desktop
