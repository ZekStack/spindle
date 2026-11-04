# Security policy

Spindle is in early development. Do not use pre-release builds as a privileged,
unattended GitHub organization automation system.

Report vulnerabilities privately to the repository maintainers via
GitHub's security advisory reporting, if enabled. Otherwise contact the
maintainers privately before public disclosure.

Security baseline: renderer sandbox and context isolation, no Node access in
React, explicit IPC methods, GitHub URL allowlisting, main-process-only
credentials and data validation at every native boundary.

Future release management will require explicit confirmations,
permission checks, operation audit history and atomic/idempotent handling of
partially completed GitHub mutations.
