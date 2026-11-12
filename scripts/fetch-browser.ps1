<#
.SYNOPSIS
    Fetch the pinned browser engine into runtime/ so nMedia renders with its own
    Chromium instead of whatever the host happens to have installed.

.DESCRIPTION
    Downloads chrome-headless-shell from Chrome for Testing (the same distribution
    Puppeteer ships), verifies its SHA-256 against runtime/browser.lock.json, and
    extracts it to runtime/chrome-headless-shell-win64/. The service resolves that
    path ahead of any system browser, so the rendering version is a build fact
    rather than a property of the machine.

    The lock is written on the first fetch and enforced afterwards: a download whose
    hash disagrees with the lock is refused, because a silent engine upgrade is
    exactly the drift this is meant to prevent.

.EXAMPLE
    powershell -NoProfile -File scripts/fetch-browser.ps1
    powershell -NoProfile -File scripts/fetch-browser.ps1 -Version latest
    powershell -NoProfile -File scripts/fetch-browser.ps1 -Version 157.0.8103.78 -Force
#>
param(
    [string]$Version = '157.0.8103.78',
    [string]$Platform = 'win64',
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$root = Split-Path -Parent $PSScriptRoot
$runtime = Join-Path $root 'runtime'
$lockPath = Join-Path $runtime 'browser.lock.json'
$folder = 'chrome-headless-shell-' + $Platform
$target = Join-Path $runtime $folder
$exe = Join-Path $target 'chrome-headless-shell.exe'

function Get-StableVersion {
    $json = Invoke-RestMethod -Uri 'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions.json' -TimeoutSec 30
    return $json.channels.Stable.version
}

function Read-Lock {
    if (-not (Test-Path $lockPath)) { return $null }
    return (Get-Content $lockPath -Raw | ConvertFrom-Json)
}

if ($Version -eq 'latest') { $Version = Get-StableVersion }

$url = "https://storage.googleapis.com/chrome-for-testing-public/$Version/$Platform/$folder.zip"
$lock = Read-Lock

if (-not $Force -and (Test-Path $exe)) {
    if ($lock -and $lock.version -eq $Version) {
        Write-Output "browser present and pinned: $exe ($Version)"
        return
    }
    if (-not $lock) {
        Write-Output "browser present at $exe but no lock file - re-fetching to record what it actually is"
    } else {
        Write-Output "lock records $($lock.version), requested $Version - re-fetching to change engines"
    }
}

New-Item -ItemType Directory -Force -Path $runtime | Out-Null
$zip = Join-Path $runtime ($folder + '.zip')

Write-Output "downloading $url"
& curl.exe -sS -L --fail -o $zip $url
if ($LASTEXITCODE -ne 0) { throw "download failed (curl exit $LASTEXITCODE)" }

$stream = [System.IO.File]::OpenRead($zip)
$head = New-Object byte[] 2
$read = $stream.Read($head, 0, 2)
$stream.Close()
if ($read -ne 2 -or $head[0] -ne 0x50 -or $head[1] -ne 0x4B) { throw "downloaded file is not a zip: $zip" }

$sha = (Get-FileHash -Path $zip -Algorithm SHA256).Hash.ToLower()
if ($lock -and $lock.version -eq $Version -and $lock.sha256 -ne $sha) {
    Remove-Item $zip -Force
    throw "sha256 mismatch for $Version - lock has $($lock.sha256), download has $sha. Refusing to install."
}

if (Test-Path $target) { Remove-Item $target -Recurse -Force }
Expand-Archive -Path $zip -DestinationPath $runtime -Force
Remove-Item $zip -Force

if (-not (Test-Path $exe)) { throw "archive did not contain $exe" }

$stamp = Get-Date -Format 'yyyy-MM-ddTHH:mm:ssZ'
$lockObject = [ordered]@{ version = $Version; platform = $Platform; url = $url; sha256 = $sha; fetchedAt = $stamp }
$json = $lockObject | ConvertTo-Json
[System.IO.File]::WriteAllText($lockPath, $json, (New-Object System.Text.UTF8Encoding $false))

Write-Output "installed: $exe"
Write-Output ("version: " + $Version + " sha256 " + $sha)
