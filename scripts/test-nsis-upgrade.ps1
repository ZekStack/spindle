# Intentionally operates only on an ephemeral Windows GitHub Actions runner.
# Both NSIS installers are generated from this CI checkout and never published.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($env:CI -ne 'true' -or $env:RUNNER_OS -ne 'Windows') {
  throw 'NSIS upgrade integration may only run on a Windows CI runner'
}

$oldVersion = '0.1.0-rc.9000'
$newVersion = '0.1.0-rc.9001'
$installRoot = Join-Path $env:RUNNER_TEMP 'spindle-nsis-integration'
$destination = Join-Path $installRoot 'installed'
New-Item -ItemType Directory -Path $installRoot -Force | Out-Null

# NSIS /D= must be the final argument, with an absolute path and no quotes.
# Keep the integration location free of spaces to preserve those semantics.
if (-not [IO.Path]::IsPathRooted($destination) -or $destination -match '\s') {
  throw 'NSIS smoke install path must be absolute and contain no spaces'
}

function Invoke-Native {
  param(
    [Parameter(Mandatory)][string]$Path,
    [string[]]$Arguments = @(),
    [int]$TimeoutSeconds = 180,
    [string]$ProofFile = ''
  )
  $start = [Diagnostics.ProcessStartInfo]::new()
  $start.FileName = $Path
  $start.UseShellExecute = $false
  foreach ($arg in $Arguments) { [void]$start.ArgumentList.Add($arg) }
  if ($ProofFile) {
    $start.Environment['SPINDLE_SMOKE_TEST'] = '1'
    $start.Environment['SPINDLE_SMOKE_INSTALLED_NSIS'] = '1'
    $start.Environment['SPINDLE_SMOKE_RESULT_FILE'] = $ProofFile
  }
  $process = [Diagnostics.Process]::Start($start)
  if ($null -eq $process) { throw "Failed to start $Path" }
  try {
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
      $process.Kill($true)
      throw "Timed out waiting for $Path"
    }
    if ($process.ExitCode -ne 0) {
      throw "$Path exited with code $($process.ExitCode)"
    }
  } finally {
    $process.Dispose()
  }
}

function Install-Version {
  param([Parameter(Mandatory)][string]$Version)
  $setup = Join-Path (Resolve-Path 'release').Path "Spindle-Setup-$Version-windows-x64.exe"
  if (-not (Test-Path -LiteralPath $setup -PathType Leaf)) {
    throw "Missing NSIS installer for $Version"
  }
  Invoke-Native -Path $setup -Arguments @('/S', "/D=$destination") -TimeoutSeconds 240
  if (-not (Test-Path -LiteralPath (Join-Path $destination 'spindle.exe') -PathType Leaf)) {
    throw "Silent NSIS installer did not create spindle.exe for $Version"
  }
}

function Verify-Installed {
  param([Parameter(Mandatory)][string]$Version)
  $exe = Join-Path $destination 'spindle.exe'
  $proof = Join-Path $installRoot "smoke-$Version.json"
  if (Test-Path -LiteralPath $proof) { throw 'Smoke proof was already present' }

  # The packaged renderer + preload + main process must launch and report the
  # expected updater state, format and version before writing the proof file.
  Invoke-Native -Path $exe -Arguments @('--disable-gpu') -TimeoutSeconds 60 -ProofFile $proof
  if (-not (Test-Path -LiteralPath $proof -PathType Leaf)) {
    throw "Installed $Version app did not complete smoke checks"
  }
  $result = Get-Content -LiteralPath $proof -Raw | ConvertFrom-Json
  if ($result.version -cne $Version -or $result.installType -cne 'nsis' -or
      $result.phase -cne 'idle') {
    throw "Unexpected installed NSIS smoke result for $Version"
  }
  $asar = Join-Path $destination 'resources\app.asar'
  if (-not (Test-Path -LiteralPath $asar -PathType Leaf)) {
    throw "Installed $Version application archive is missing"
  }
  return (Get-FileHash -LiteralPath $asar -Algorithm SHA256).Hash
}

Install-Version -Version $oldVersion
$oldHash = Verify-Installed -Version $oldVersion
Install-Version -Version $newVersion
$newHash = Verify-Installed -Version $newVersion
if ($oldHash -ceq $newHash) {
  throw 'NSIS upgrade did not replace the installed application archive'
}
Write-Host "Native NSIS package upgrade passed: $oldVersion -> $newVersion"
