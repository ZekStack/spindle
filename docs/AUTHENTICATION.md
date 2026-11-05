# GitHub authentication in Spindle

## Available authentication methods (M1.1–M1.2)

The account dialog shows the current GitHub account, optional avatar/name,
credential source, OAuth scopes when reported, and distinct invalid,
rate-limited, forbidden and offline states.

Credential selection in Electron main is:

1. A Spindle-managed GitHub OAuth token, if the user signed in through the
   app and a supported OS credential store is accessible.
2. An external `GH_TOKEN` / `GITHUB_TOKEN` inherited by the app process.
3. Existing `gh auth token` from GitHub CLI.
4. Anonymous browsing of public GitHub repositories.

An in-app sign-out **only removes Spindle's own token**. It never calls
`gh auth logout` or modifies an environment variable. Consequently,
signing out can reveal an already configured external identity. The account
dialog refreshes and clears cached GitHub data after switching accounts.

## First-party GitHub sign-in (M1.2)

Open the account dialog and select **Continue with GitHub**. This uses
GitHub's OAuth device authorization protocol.

The project intentionally ships with **no embedded OAuth client secret or
proprietary, organization-specific client ID**. A GitHub OAuth app with
device-flow authorization enabled must be configured to use this option.
Enter its **public OAuth client ID** in the account dialog, or set the
`SPINDLE_GITHUB_CLIENT_ID` environment variable when launching Spindle.
This is configuration, not a personal access token. Public/CLI browsing
continues to work without a configured OAuth app.

The main process posts to `https://github.com/login/device/code` using
the client ID with requested OAuth scopes `repo read:org`. Only the
verification URL `https://github.com/login/device`, the short **user
code**, expiry, and next polling time cross the typed preload API.

The renderer opens the GitHub verification page through the existing
GitHub-only external link guard. It displays the user code and waits for
approval, using rate-limited calls to the main process. The private
`device_code`, access token, request headers and raw API errors never
cross IPC. Main enforces GitHub's minimum poll interval, handles
`authorization_pending`, `slow_down`, denial, expiry and cancellation,
and verifies `GET /user` before persisting the acquired token.

### OS-backed credential security

Spindle uses Electron's **asynchronous** `safeStorage` encryption methods.
The encrypted token lives only in the Electron user-data directory, in an
atomic, private file `github-token.enc`, not in the workspace, renderer
localStorage, logs or repository files.

- **Windows:** the async provider uses DPAPI to protect the key.
- **Linux:** GNOME libsecret / GNOME Keyring or KWallet must be available.
  The app **fails closed** when Electron reports the insecure `basic_text`
  backend, an unknown backend, or no encryption. There is no plaintext
  fallback. Unlock or configure the OS keyring to enable in-app sign-in.
- On an OS key rotation, Spindle re-encrypts the token when the async
  decryptor reports `shouldReEncrypt`.

Credential lookup for ordinary repository requests and updater GitHub
downloads uses the same managed credential store as the account dialog.
This means a successful in-app sign-in works without a separately entered
GitHub CLI token. The secure credential can be reloaded after app restart.

### Expired and revoked credentials

The device authorization code itself expires after GitHub's documented
period. Invalid/revoked application tokens are reported through the
account identity's `401` state and cannot be assumed to authorize
repository operations. Users can sign out locally and reauthorize.

**Sign out locally does not revoke a token on GitHub.** Users may revoke
the OAuth application's access under their GitHub settings → Applications.
The app never claims to have revoked a remote authorization when it merely
removes the encrypted local token. Fine-grained permissions and OAuth
scope headers are not equivalent to actual repository authorization.

## M1.2 acceptance scope

Implementation includes interactive device-code sign-in, credential
preference, safe storage, restart persistence, account switching and
Spindle-only sign-out, plus tests for polling and insecure backend
rejection. **Real interactive OAuth authorization and keyring persistence
on Linux Mint and Windows require desktop QA with a configured GitHub
OAuth application** before marking the full M1.2 acceptance gate complete.

No bundled client secret or plaintext token store is used.
