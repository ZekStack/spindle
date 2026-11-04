#!/usr/bin/env bash
# Tests the exact generated Linux distributables on an ephemeral CI runner.
# Reused by PR CI and tagged Release builds so prepublication checks are
# exercised before a GitHub Release is ever created.
set -euo pipefail

if [[ "${CI:-}" != "true" || "${RUNNER_OS:-}" != "Linux" || $# -ne 1 ]]; then
  echo "Usage (Linux CI only): bash scripts/smoke-release-linux.sh VERSION" >&2
  exit 1
fi
version="$1"
node scripts/prepare-release.mjs --validate "v$version" > /dev/null

deb="release/Spindle-${version}-linux-x64.deb"
appimage="release/Spindle-${version}-linux-x64.AppImage"
if [[ ! -f "$deb" || ! -f "$appimage" ]]; then
  echo "Missing Linux installer for version $version" >&2
  exit 1
fi

# Verify the real DEB package and packaged updater identity.
sudo apt-get install --yes "./$deb"
installed="$(dpkg-query --show --showformat='${Version}' spindle)"
expected="${version/-rc./~rc.}"
if [[ "$installed" != "$expected" ]]; then
  echo "::error::Installed Debian version '$installed' differs from expected '$expected'" >&2
  exit 1
fi
SPINDLE_SMOKE_TEST=1 \
SPINDLE_SMOKE_INSTALLED_DEB=1 \
  xvfb-run -a timeout 45s /opt/Spindle/spindle --no-sandbox
echo "Tagged Debian package smoke passed: $version"

# Execute the actual AppImage runtime without requiring FUSE on hosted CI.
image="$(realpath "$appimage")"
chmod +x "$image"
SPINDLE_SMOKE_TEST=1 \
SPINDLE_SMOKE_APPIMAGE=1 \
SPINDLE_SMOKE_EXPECTED_APPIMAGE="$image" \
APPIMAGE_EXTRACT_AND_RUN=1 \
  xvfb-run -a timeout 120s "$image" --no-sandbox
echo "Tagged AppImage package smoke passed: $version"
