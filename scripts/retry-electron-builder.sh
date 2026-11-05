#!/usr/bin/env bash
set -euo pipefail

# electron-builder downloads platform packagers from external CDNs. A
# transient 504/ECONNRESET should not fail an otherwise healthy native smoke
# job. Deterministic failures still fail after three bounded attempts.
if [[ "$#" -lt 1 ]]; then
  echo 'Specify electron-builder arguments' >&2
  exit 2
fi

for attempt in 1 2 3; do
  if pnpm exec electron-builder "$@"; then
    exit 0
  fi
  if [[ "$attempt" -eq 3 ]]; then
    echo "Electron packaging failed after 3 attempts" >&2
    exit 1
  fi
  delay=$((attempt * 15))
  echo "Electron packaging attempt $attempt failed; retrying in ${delay}s" >&2
  sleep "$delay"
done
