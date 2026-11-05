#!/usr/bin/env bash
set -euo pipefail

# electron-builder lazily downloads external AppImage tooling from upstream.
# Retry transient CDN gateway/connection failures, but never report success
# without a completed build. The existing packaging smoke test still validates
# the resulting executable and update metadata.
for attempt in 1 2 3; do
  if pnpm exec electron-builder --linux AppImage --x64 --publish never; then
    exit 0
  fi
  if [[ "$attempt" -eq 3 ]]; then
    echo "AppImage packaging failed after 3 attempts" >&2
    exit 1
  fi
  delay=$((attempt * 15))
  echo "AppImage packaging attempt $attempt failed; retrying in ${delay}s" >&2
  sleep "$delay"
done
