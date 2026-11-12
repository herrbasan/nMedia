# Renders storage SVG charts through the nMedia port with BOTH SVG engines
# (resvg in-process, chromium as a child), so the two can be compared on the same
# file. Writes an index.html contact sheet.
#
#   powershell -NoProfile -File crates\nmedia\tests\render-charts.ps1
#   NMEDIA_URL  service base URL (default http://127.0.0.1:3502)
#   OUT_DIR     output folder (default D:\MCP_Storage\nmedia-svg-preview)

$ErrorActionPreference = 'Continue'
$base = if ($env:NMEDIA_URL) { $env:NMEDIA_URL } else { 'http://127.0.0.1:3502' }
$outDir = if ($env:OUT_DIR) { $env:OUT_DIR } else { 'D:\MCP_Storage\nmedia-svg-preview' }
New-Item -ItemType Directory -Force -Path (Join-Path $outDir 'resvg'), (Join-Path $outDir 'chromium') | Out-Null

$picks = @(
    'charts\20261110_1655_religion-overture-map-v2.svg',
    'charts\20261019_2254_showcase-flow-gateway.svg',
    'charts\20261019_2254_showcase-tree-latency.svg',
    'charts\20261019_2254_showcase-matrix-fit.svg',
    'charts\20261019_2254_showcase-timeline-memory.svg',
    'charts\20261019_2254_showcase-table-comparison.svg',
    'charts\20261019_2254_showcase-bars-tones.svg',
    'charts\20261019_2254_showcase-cycle-loop.svg',
    'charts\20261019_2254_showcase-steps-ramp.svg',
    'charts\20261108_0944_taxonomy-tree.svg',
    'charts\20261108_0949_ground-relation-clean.svg',
    'charts\20261108_1126_the-1-2x-trapadoptiondelight.svg'
)

function Get-SvgSize([string]$path) {
    $text = [System.IO.File]::ReadAllText($path)
    if ($text -match '<svg[^>]*\swidth="([\d.]+)(?:px)?"[^>]*\sheight="([\d.]+)(?:px)?"') {
        return @([int][double]$Matches[1], [int][double]$Matches[2])
    }
    if ($text -match '<svg[^>]*\sviewBox="0 0 ([\d.]+) ([\d.]+)"') {
        return @([int][double]$Matches[1], [int][double]$Matches[2])
    }
    return @(1200, 800)
}

function Post-Json([string]$url, [string]$json) {
    $file = Join-Path $env:TEMP ('svg-body-' + [guid]::NewGuid().ToString('N') + '.json')
    [System.IO.File]::WriteAllText($file, $json, (New-Object System.Text.UTF8Encoding $false))
    $raw = curl.exe -s -X POST $url -H 'Content-Type: application/json' --data "@$file"
    Remove-Item $file -Force
    return $raw
}

function Wait-Finished([string]$jobId) {
    $record = $null
    $deadline = (Get-Date).AddSeconds(120)
    while ((Get-Date) -lt $deadline) {
        $record = (curl.exe -s "$base/v1/jobs/$jobId" | ConvertFrom-Json).data
        if ($record.status -in @('completed', 'failed', 'cancelled', 'interrupted')) { return $record }
        Start-Sleep -Milliseconds 250
    }
    return $record
}

$results = @()
foreach ($rel in $picks) {
    $src = Join-Path 'D:\MCP_Storage' $rel
    if (-not (Test-Path -LiteralPath $src)) { Write-Output "missing: $rel"; continue }
    $name = [System.IO.Path]::GetFileNameWithoutExtension($src)
    $dims = Get-SvgSize $src

    $upload = curl.exe -s -X POST "$base/v1/upload" -H 'Content-Type: application/octet-stream' -H "X-Original-Filename: $name.svg" --data-binary "@$src" | ConvertFrom-Json
    if (-not $upload.success) { Write-Output "upload failed: $name - $($upload.error)"; continue }

    $entry = [ordered]@{ File = $rel; Size = "$($dims[0])x$($dims[1])"; resvg = ''; chromium = ''; Note = '' }

    foreach ($engine in @('resvg', 'chromium')) {
        $payload = @{ file_id = $upload.data.fileId; processor = 'image'; options = @{ format = 'png'; engine = $engine } } | ConvertTo-Json -Depth 5 -Compress
        $submitted = Post-Json "$base/v1/process" $payload | ConvertFrom-Json
        if (-not $submitted.data.jobId) {
            $entry.Note = "$engine rejected: $($submitted.error)"
            Write-Output ("REJECT  {0} ({1}) - {2}" -f $name, $engine, $submitted.error)
            continue
        }
        $record = Wait-Finished $submitted.data.jobId
        if ($record.status -ne 'completed' -or -not $record.assetId) {
            $entry.Note = "$engine failed: $($record.error)"
            Write-Output ("FAILED  {0} ({1}) - {2}" -f $name, $engine, $record.error)
            continue
        }
        $target = Join-Path (Join-Path $outDir $engine) "$name.png"
        $http = curl.exe -s -w '%{http_code}' "$base/v1/assets/$($record.assetId)" -o $target
        $bytes = (Get-Item -LiteralPath $target).Length
        if ("$http" -eq '200' -and $bytes -gt 0) {
            $entry[$engine] = "$engine/$name.png"
            Write-Output ("ok      {0,-52} {1,-9} {2} bytes" -f $name, $engine, $bytes)
        } else {
            $entry.Note = "$engine download http=$http"
            Write-Output ("FAILED  {0} ({1}) download http={2}" -f $name, $engine, $http)
        }
    }
    $results += [pscustomobject]$entry
}

$lines = @(
    '<!doctype html><html><head><meta charset="utf-8"><title>nMedia SVG render check</title>',
    '<style>body{font:14px/1.4 system-ui,sans-serif;margin:24px;background:#f6f6f6;color:#222}',
    'table{border-collapse:collapse;background:#fff}td,th{border:1px solid #ddd;padding:8px;vertical-align:top}',
    'img{max-width:620px;display:block}code{font-size:12px}.n{color:#b00;font-size:12px}</style></head><body>',
    '<h1>SVG render check - resvg vs chromium</h1>',
    '<p>Same storage file, same service, different <code>engine</code> option. Left: resvg (in-process). Right: chromium (child process).</p>',
    '<table><tr><th>file</th><th>size</th><th>resvg</th><th>chromium</th></tr>'
)
foreach ($r in $results) {
    $left = if ($r.resvg) { '<img src="' + $r.resvg + '">' } else { '<em>n/a</em>' }
    $right = if ($r.chromium) { '<img src="' + $r.chromium + '">' } else { '<em>n/a</em>' }
    $note = if ($r.Note) { '<div class="n">' + $r.Note + '</div>' } else { '' }
    $lines += '<tr><td><code>' + $r.File + '</code>' + $note + '</td><td>' + $r.Size + '</td><td>' + $left + '</td><td>' + $right + '</td></tr>'
}
$lines += '</table></body></html>'
$index = Join-Path $outDir 'index.html'
[System.IO.File]::WriteAllText($index, ($lines -join "`n"), (New-Object System.Text.UTF8Encoding $false))

$ok = ($results | Where-Object { $_.resvg -and $_.chromium }).Count
Write-Output ''
Write-Output ("rendered both engines for {0} of {1} file(s)" -f $ok, $picks.Count)
Write-Output "open: $index"
