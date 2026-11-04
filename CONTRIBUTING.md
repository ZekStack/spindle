# Contributing to Spindle

Thank you for contributing. Spindle is GitHub-first but not organization-specific.

1. Open a focused issue or PR with scope and expected behavior.
2. Use pnpm exclusively and update `pnpm-lock.yaml` when dependencies change.
3. Run `pnpm typecheck`, `pnpm test`, and `pnpm build`.
4. Keep privileged operations in the Electron main process. All renderer access
   must be through typed, narrowly scoped preload IPC functions.
5. Add regression tests for repository state, authentication boundaries,
   tag/ref safety, and workflow status behavior.
6. Never commit tokens, user workspace paths, or organization-specific defaults.

Use small feature modules and keep each source file focused.
