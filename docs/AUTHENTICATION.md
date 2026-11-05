# GitHub identity and authentication

## Implemented: account identity (M1.1)

Spindle's header now opens an account dialog showing the authenticated
GitHub login, optional display name/avatar, credential source, and OAuth
scopes reported by GitHub. The account lookup runs in Electron main via
`GET https://api.github.com/user`; only an allowlisted, safe identity shape
crosses IPC. Tokens, response headers and raw HTTP errors remain in main.

Credentials currently come from `GH_TOKEN`/`GITHUB_TOKEN`, then `gh auth
token`, then anonymous public access. Explicit **Refresh account** clears
the GitHub CLI token cache and rechecks the viewer, so signing in/out with
the CLI is reflected without restarting the desktop application.
The account dialog differentiates missing/invalid credentials, API rate
limits, forbidden access and network/service failures.

GitHub may omit `X-OAuth-Scopes` for fine-grained credentials. Displayed
scopes are informative, **not** a guarantee of authorization to any
specific organization or repository. The app makes the actual GitHub API
request before reporting repository data. No global GitHub CLI credentials
are modified or revoked by Spindle.

## Optional first-party sign-in design (M1.2 prerequisite)

A later first-party sign-in option can use GitHub's OAuth device flow,
**without a bundled client secret**:

1. Accept a configured OAuth app client ID (for example
   `SPINDLE_GITHUB_CLIENT_ID`) only if a maintainer has provisioned one.
   Do not assume every community fork uses the same OAuth application.
2. Main requests a device code from `https://github.com/login/device/code`
   with narrowly scoped permissions. The renderer receives only the
   verification URI, user code, expiry and poll interval; the private
   device code is retained in main.
3. Open the verification page only via a strict GitHub HTTPS URL
   allowlist. Poll `https://github.com/login/oauth/access_token`
   respecting `authorization_pending`, `slow_down`, expiry,
   denial and explicit cancellation.
4. Save the acquired access token **only after** M1.2 introduces a
   supported operating-system secret store. Never persist it in the
   workspace JSON, renderer storage, logs, or an unencrypted fallback.
   If no secure storage is available, disable first-party persistence.
5. Sign-out removes/revokes **only the Spindle-managed token**. It must
   never run `gh auth logout` automatically or alter environment tokens
   shared with other applications. Credential precedence and account
   switching must be explicit before this mode is enabled.

Until the secure credential and lifecycle work is completed, Spindle
continues supporting the existing GitHub CLI/environment authentication
and anonymous public browsing. This document is a design, **not** a claim
that first-party OAuth sign-in or in-app sign-out is available today.
