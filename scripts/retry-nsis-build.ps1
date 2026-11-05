$ErrorActionPreference = 'Stop'

# electron-builder retrieves NSIS tooling from external release/CDN hosts.
# Retry transient gateway failures without relaxing any packaged smoke checks.
for ($attempt = 1; $attempt -le 3; $attempt++) {
  pnpm exec electron-builder --win nsis --x64 --publish never
  if ($LASTEXITCODE -eq 0) {
    return
  }

  if ($attempt -eq 3) {
    throw 'Windows installer packaging failed after three attempts.'
  }
  $delay = 15 * $attempt
  Write-Warning "NSIS packaging attempt $attempt failed; retrying in $delay seconds."
  Start-Sleep -Seconds $delay
}
