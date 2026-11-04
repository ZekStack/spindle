# Spindle

A cross-platform desktop workspace for GitHub organizations, repositories,
releases and GitHub Actions — developed by [ZekStack](https://github.com/ZekStack).

Spindle is designed for developers who manage repositories across multiple
organizations. It is not tied to Hitec Smart Home or a fixed repository catalog.

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

**Bootstrap note:** this initial PR does not contain a generated
`pnpm-lock.yaml` because the package registry is unavailable from the
authoring environment. Generate it with `pnpm install` on a connected machine,
commit it, then change CI installation to `pnpm install --frozen-lockfile`.
Do not merge until the lockfile and full build are verified.

## First-use workflow

1. Open Spindle and add any GitHub organization (for example ZekStack).
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

**Authentication:** R1 reads the existing GitHub CLI token when available,
falling back to environment credentials or anonymous public access.
A dedicated GitHub OAuth device-flow onboarding experience and native
secure token storage are planned for R2. Do not distribute PATs or package
credentials with the application.

## Roadmap

See [docs/ROADMAP.md](docs/ROADMAP.md) for staged work and acceptance gates.

## Contributing

Spindle uses the MIT License. Open an issue or PR with a focused change and
tests. Keep organization identifiers and release workflows configurable,
avoid embedding secrets, and require an explicit confirmation for future
remote mutations.
