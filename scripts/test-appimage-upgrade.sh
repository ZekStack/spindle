#!/usr/bin/env bash
# Native, unpublished AppImage replacement integration on an ephemeral Ubuntu CI runner.
set -euo pipefail

if [[ "${CI:-}" != "true" || "${RUNNER_OS:-}" != "Linux" ||
      "${SPINDLE_NATIVE_APPIMAGE_UPGRADE:-}" != "1" ]]; then
  echo "This test requires an opted-in Linux CI runner" >&2
  exit 1
fi

old_version="0.1.0-rc.9000"
new_version="0.1.0-rc.9001"
root="${RUNNER_TEMP:?}/spindle-appimage-integration"
mkdir -p "$root"
target="$root/spindle.AppImage"

verify_portable() {
  local expected="$1"
  local proof="$root/smoke-$expected.json"
  [[ ! -e "$proof" ]] || { echo "Stale smoke result" >&2; exit 1; }

  # AppImage's supported extract-and-run mode avoids depending on /dev/fuse
  # in GitHub-hosted CI. The AppImage runtime itself must still launch the app
  # and supply APPIMAGE pointing to the actual portable executable.
  SPINDLE_SMOKE_TEST=1 \
  SPINDLE_SMOKE_APPIMAGE=1 \
  SPINDLE_SMOKE_EXPECTED_APPIMAGE="$target" \
  SPINDLE_SMOKE_RESULT_FILE="$proof" \
  APPIMAGE_EXTRACT_AND_RUN=1 \
    xvfb-run -a timeout 120s "$target" --no-sandbox

  node - "$proof" "$expected" <<'NODE'
const fs = require('node:fs')
const assert = require('node:assert/strict')
const [file, expected] = process.argv.slice(2)
const value = JSON.parse(fs.readFileSync(file, 'utf8'))
assert.deepEqual(value, {
  version: expected, installType: 'appimage', phase: 'idle'
})
NODE
  echo "AppImage runtime and updater identity passed: $expected"
}

old_file="$root/Spindle-$old_version-linux-x64.AppImage"
new_file="release/Spindle-$new_version-linux-x64.AppImage"
[[ -f "$old_file" && -f "$new_file" ]] || {
  echo "Both unpublished AppImage artifacts must exist" >&2
  exit 1
}

# An AppImage is a portable executable, not an OS-installed package.
# Preserve the launch pathname while replacing the bytes, then verify the
# second packaged application reports its new version.
cp "$old_file" "$target"
chmod 755 "$target"
old_sha="$(sha256sum "$target" | cut -d' ' -f1)"
verify_portable "$old_version"

cp "$new_file" "$target"
chmod 755 "$target"
new_sha="$(sha256sum "$target" | cut -d' ' -f1)"
[[ "$new_sha" != "$old_sha" ]] || {
  echo "Portable AppImage was not replaced by a different build" >&2
  exit 1
}
verify_portable "$new_version"
echo "Native AppImage portable replacement passed: $old_version -> $new_version"
