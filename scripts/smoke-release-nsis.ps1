# Runs only inside the release workflow, after the tagged NSIS installer is built.
# Installs the exact release asset on an ephemeral Windows runner before publish.
param([Parameter(Mandatory = $true)][string]$Version)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($env:CI -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or
    $env:SPINDLE_RELEASE_SMOKE -ne '1' -or
    $Version -cnotmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-rc\.(0|[1-9]\d*))?$') {
  throw 'Native NSIS release smoke requires an opted-in Windows CI run and a valid version'
}

$root = Join-Path $env:RUNNER_TEMP 'spindle-release-smoke'
$destination = Join-Path $root 'installed'
$proof = Join-Path $root 'result.json'
$installer = Join-Path (Resolve-Path 'release').Path "Spindle-Setup-$Version-windows-x64.exe"
New-Item -ItemType Directory -Path $root -Force | Out-Null

if (-not (Test-Path -LiteralPath $installer -PathType Leaf) -or
    -not [IO.Path]::IsPathRooted($destination) -or $destination -match '\s' -or
    (Test-Path -LiteralPath $proof)) {
  throw 'Invalid installer, installation directory or stale smoke result'
}

function Invoke-Bounded {
  param([string]$File, [string[]]$Arguments, [int]$TimeoutSeconds, [bool]$AppSmoke)
  $start = [Diagnostics.ProcessStartInfo]::new()
  $start.FileName = $File
  $start.UseShellExecute = $false
  foreach ($argument in $Arguments) { [void]$start.ArgumentList.Add($argument) }
  if ($AppSmoke) {
    $start.Environment['SPINDLE_SMOKE_TEST'] = '1'
    $start.Environment['SPINDLE_SMOKE_INSTALLED_NSIS'] = '1'
    $start.Environment['SPINDLE_SMOKE_RESULT_FILE'] = $proof
  }
  $process = [Diagnostics.Process]::Start($start)
  if ($null -eq $process) { throw "Could not start $File" }
  try {
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
      $process.Kill($true)
      throw "Timed out waiting for $File"
    }
    if ($process.ExitCode -ne 0) {
      throw "$File failed with exit code $($process.ExitCode)"
    }
  } finally { $process.Dispose() }
}

# The NSIS /D= flag must be last. Never use system-wide installation paths.
Invoke-Bounded -File $installer -Arguments @('/S', "/D=$destination") -TimeoutSeconds 240 -AppSmoke $false
$exe = Join-Path $destination 'spindle.exe'
$asar = Join-Path $destination 'resources\app.asar'
if (-not (Test-Path -LiteralPath $exe -PathType Leaf) -or
    -not (Test-Path -LiteralPath $asar -PathType Leaf)) {
  throw 'Release NSIS installer did not produce a usable packaged application'
}

Invoke-Bounded -File $exe -Arguments @('--disable-gpu') -TimeoutSeconds 60 -AppSmoke $true
if (-not (Test-Path -LiteralPath $proof -PathType Leaf)) {
  throw 'Packaged Windows app did not prove its renderer/preload/updater smoke'
}
$result = Get-Content -LiteralPath $proof -Raw | ConvertFrom-Json
if ($result.version -cne $Version -or $result.installType -cne 'nsis' -or
    $result.phase -cne 'idle') {
  throw "Packaged Windows app does not match the release: $Version"
}
Write-Host "Tagged NSIS release smoke passed: $Version"
