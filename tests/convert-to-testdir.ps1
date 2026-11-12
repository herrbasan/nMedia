# Converts files into .test-output/ so the results are one click away.
#
#   powershell -NoProfile -File crates\nmedia\tests\convert-to-testdir.ps1 -Source "H:\...\Zuletzt" -Limit 5 -Format jpg
#
# HEIC/HEIF goes through ffmpeg (measured: 182 ms/file to JPEG, correct colour).
# Everything else goes through the running nmedia service, so the conversion path
# is the one that will replace the Node service.
#
#   -Source   file or folder
#   -Format   jpg | png | webp   (default jpg)
#   -Limit    max files to convert (default 8)
#   -MaxEdge  longest edge in px, 0 = keep original (default 0)
#   NMEDIA_URL  service base URL (default http://127.0.0.1:3502)

param(
    [Parameter(Mandatory = $true)][string]$Source,
    [ValidateSet('jpg', 'png', 'webp')][string]$Format = 'jpg',
    [int]$Limit = 8,
    [int]$MaxEdge = 0
)

$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)))
$outRoot = Join-Path $repo '.test-output'
$base = if ($env:NMEDIA_URL) { $env:NMEDIA_URL } else { 'http://127.0.0.1:3502' }

$files = if (Test-Path -LiteralPath $Source -PathType Container) {
    Get-ChildItem -LiteralPath $Source -File | Where-Object { $_.Extension -match '(?i)^\.(heic|heif|jpg|jpeg|png|webp|tif|tiff|bmp|gif|avif|svg)$' } | Sort-Object Name | Select-Object -First $Limit
} else {
    Get-Item -LiteralPath $Source
}
if (-not $files) { Write-Output "nothing to convert at $Source"; exit 1 }

$totalStopwatch = [System.Diagnostics.Stopwatch]::StartNew()
foreach ($file in $files) {
    $stem = [System.IO.Path]::GetFileNameWithoutExtension($file.Name)
    $ext = $file.Extension.ToLowerInvariant().TrimStart('.')
    $isHeic = $ext -in @('heic', 'heif')
    $dir = if ($isHeic) { Join-Path $outRoot 'heic' } else { Join-Path $outRoot 'image' }
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $target = Join-Path $dir "$stem.$Format"
    $sw = [System.Diagnostics.Stopwatch]::StartNew()

    # HEIC is decoded inside the service now (ffmpeg, see plan 13.2d), so every
    # format takes the same path and the same measurement.
    if ($false) {
        $args = @('-hide_banner', '-loglevel', 'error', '-y', '-i', $file.FullName, '-frames:v', '1')
        if ($MaxEdge -gt 0) { $args += @('-vf', "scale='min($MaxEdge,iw)':-2") }
        $args += $target
        & ffmpeg @args 2>$null | Out-Null
        $ok = Test-Path -LiteralPath $target
    } else {
        $upload = curl.exe -s -X POST "$base/v1/upload" -H 'Content-Type: application/octet-stream' -H "X-Original-Filename: $($file.Name)" --data-binary "@$($file.FullName)" | ConvertFrom-Json
        if (-not $upload.success) { Write-Output ("FAILED  {0} - {1}" -f $file.Name, $upload.error); continue }
        $options = @{ format = $Format }
        if ($MaxEdge -gt 0) { $options.max_dimension = $MaxEdge }
        $payload = @{ file_id = $upload.data.fileId; processor = 'image'; options = $options } | ConvertTo-Json -Depth 5 -Compress
        $tmpBody = Join-Path $env:TEMP ('conv-' + [guid]::NewGuid().ToString('N') + '.json')
        [System.IO.File]::WriteAllText($tmpBody, $payload, (New-Object System.Text.UTF8Encoding $false))
        $submitted = curl.exe -s -X POST "$base/v1/process" -H 'Content-Type: application/json' --data "@$tmpBody" | ConvertFrom-Json
        Remove-Item $tmpBody -Force
        if (-not $submitted.data.jobId) { Write-Output ("FAILED  {0} - {1}" -f $file.Name, $submitted.error); continue }
        $record = $null
        $deadline = (Get-Date).AddSeconds(180)
        while ((Get-Date) -lt $deadline) {
            $record = (curl.exe -s "$base/v1/jobs/$($submitted.data.jobId)" | ConvertFrom-Json).data
            if ($record.status -in @('completed', 'failed', 'cancelled', 'interrupted')) { break }
            Start-Sleep -Milliseconds 250
        }
        if ($record.status -ne 'completed' -or -not $record.assetId) {
            Write-Output ("FAILED  {0} - {1}" -f $file.Name, $record.error)
            continue
        }
        curl.exe -s "$base/v1/assets/$($record.assetId)" -o $target | Out-Null
        $ok = (Test-Path -LiteralPath $target) -and ((Get-Item -LiteralPath $target).Length -gt 0)
    }

    $sw.Stop()
    if ($ok) {
        Write-Output ("ok  {0,-34} -> {1,-8} {2,7:N0} ms  {3:N2} MB" -f $file.Name, $Format, $sw.Elapsed.TotalMilliseconds, ((Get-Item -LiteralPath $target).Length / 1MB))
    } else {
        Write-Output ("FAILED  {0} (no output)" -f $file.Name)
    }
}
$totalStopwatch.Stop()
Write-Output ""
Write-Output ("converted {0} file(s) in {1:N1} s -> {2}" -f $files.Count, $totalStopwatch.Elapsed.TotalSeconds, $outRoot)
