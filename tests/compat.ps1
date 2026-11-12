# Compatibility harness for the Rust nMedia port.
#
# It provisions its own fixtures (image via System.Drawing, audio/video via
# ffmpeg lavfi) so it runs anywhere, then drives the same contract the Node
# service served. Exit code is the verdict.
#
#   powershell -NoProfile -File crates\nmedia\tests\compat.ps1
#   NMEDIA_URL=http://127.0.0.1:3501   (default)

$ErrorActionPreference = 'Continue'  # ffmpeg writes its banner to stderr; that is not an error
$b = if ($env:NMEDIA_URL) { $env:NMEDIA_URL } else { 'http://127.0.0.1:3501' }
$tmp = Join-Path $env:TEMP 'nmedia-compat'
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$pass = 0; $fail = 0

function Check($name, $ok, $detail = '') {
    if ($ok) { $script:pass++; Write-Output "  ok   $name" }
    else { $script:fail++; Write-Output "  FAIL $name $detail" }
}
function Post-Json($url, $obj) {
    $f = Join-Path $tmp ('b-' + [guid]::NewGuid().ToString('N') + '.json')
    [System.IO.File]::WriteAllText($f, ($obj | ConvertTo-Json -Depth 8 -Compress), (New-Object System.Text.UTF8Encoding $false))
    $r = curl.exe -s -X POST $url -H "Content-Type: application/json" --data "@$f"
    Remove-Item $f -Force
    return $r
}
function Upload($path, $name) {
    return (curl.exe -s -X POST "$b/v1/upload" -H "Content-Type: application/octet-stream" -H "X-Original-Filename: $name" --data-binary "@$path" | ConvertFrom-Json).data
}
function Wait-Job($id, $seconds = 180) {
    $deadline = (Get-Date).AddSeconds($seconds)
    $j = $null
    while ((Get-Date) -lt $deadline) {
        $j = (curl.exe -s "$b/v1/jobs/$id" | ConvertFrom-Json).data
        if ($j.status -in 'completed', 'failed', 'cancelled', 'interrupted') { return $j }
        Start-Sleep -Milliseconds 300
    }
    return $j
}

# ── fixtures ────────────────────────────────────────────────────────────
$png = Join-Path $tmp 'test.png'
if (-not (Test-Path $png)) {
    Add-Type -AssemblyName System.Drawing
    $bmp = New-Object System.Drawing.Bitmap 400, 300
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.Clear([System.Drawing.Color]::SteelBlue)
    $g.FillEllipse([System.Drawing.Brushes]::Orange, 50, 50, 200, 150)
    $g.Dispose(); $bmp.Save($png, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
}
$mp3 = Join-Path $tmp 'tone.mp3'
if (-not (Test-Path $mp3)) { & ffmpeg -loglevel error -y -f lavfi -i "sine=frequency=440:duration=3" -c:a libmp3lame $mp3 2>$null }
$mp4 = Join-Path $tmp 'tiny.mp4'
if (-not (Test-Path $mp4)) {
    & ffmpeg -loglevel error -y -f lavfi -i "testsrc=duration=3:size=128x96:rate=10" -f lavfi -i "sine=frequency=440:duration=3" -c:v libx264 -pix_fmt yuv420p -c:a aac $mp4 2>$null
}
$slow = Join-Path $tmp 'slow.mp4'
if (-not (Test-Path $slow)) {
    & ffmpeg -loglevel error -y -f lavfi -i "testsrc=duration=60:size=1280x720:rate=30" -f lavfi -i "sine=frequency=220:duration=60" -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac $slow 2>$null
}

Write-Output "== health =="
$h = (curl.exe -s "$b/health" | ConvertFrom-Json)
Check 'status ok' ($h.status -eq 'ok') "got $($h.status)"
Check 'image ready' ($h.processors.image -eq 'ready') "got $($h.processors.image)"
Check 'audio+video ready' ($h.processors.audio -eq 'ready' -and $h.processors.video -eq 'ready') "audio=$($h.processors.audio) video=$($h.processors.video)"

Write-Output "== capabilities contract =="
$caps = (curl.exe -s "$b/v1/capabilities" | ConvertFrom-Json)
Check 'envelope has data.service' ([bool]$caps.data.service)
Check 'endpoints listed' ($caps.data.service.endpoints.Count -ge 15) "count=$($caps.data.service.endpoints.Count)"
$slice = (curl.exe -s "$b/v1/capabilities?section=features" | ConvertFrom-Json)
Check 'section slice returns features directly' ([bool]$slice.data.processors) "got $($slice | ConvertTo-Json -Compress -Depth 2)"

Write-Output "== image lane =="
$up = Upload $png 'test.png'
Check 'upload returns fileId' ([bool]$up.fileId) "size=$($up.size)"
$proc = (Post-Json "$b/v1/process" @{ file_id = $up.fileId; processor = 'image'; options = @{ max_dimension = 100; format = 'png' } }) | ConvertFrom-Json
Check 'process returns jobId' ([bool]$proc.data.jobId)
$job = Wait-Job $proc.data.jobId 60
Check 'image job completed' ($job.status -eq 'completed') "status=$($job.status) error=$($job.error)"
if ($job.assetId) {
    $out = Join-Path $tmp 'out-100.png'
    curl.exe -s "$b/v1/assets/$($job.assetId)" -o $out | Out-Null
    Add-Type -AssemblyName System.Drawing
    $img = [System.Drawing.Image]::FromFile($out)
    Check 'asset resized to 100px' ($img.Width -eq 100) "got $($img.Width)x$($img.Height)"
    $img.Dispose()
}

Write-Output "== option contract =="
$bad = (Post-Json "$b/v1/process" @{ file_id = $up.fileId; processor = 'image'; options = @{ maxDim = 50 } }) | ConvertFrom-Json
Check 'unknown option rejected at the boundary' (-not $bad.success)
$svg = (Post-Json "$b/v1/process" @{ file_id = $up.fileId; processor = 'image'; options = @{ svg = @{ width = 10 } } }) | ConvertFrom-Json
Check 'unimplemented engine option refused by name' (-not $svg.success -and "$($svg.error)" -match 'engine')

Write-Output "== legacy synchronous =="
$legacy = (Post-Json "$b/v1/process/image" @{ file_id = $up.fileId; max_dimension = 50; format = 'jpeg'; quality = 70 }) | ConvertFrom-Json
Check 'legacy image returns an asset' ($legacy.success -eq $true -and $legacy.data.width -eq 50)

Write-Output "== utilities =="
$info = (curl.exe -s "$b/v1/info/$([uri]::EscapeDataString($png))" | ConvertFrom-Json)
Check 'info reads dimensions' ($info.data.width -eq 400 -and $info.data.height -eq 300)
$thumb = Join-Path $tmp 'thumb.png'
curl.exe -s "$b/v1/thumbnail/$([uri]::EscapeDataString($png))?width=64" -o $thumb | Out-Null
Check 'thumbnail returns bytes' ((Get-Item $thumb).Length -gt 100)

Write-Output "== audio lane =="
$upA = Upload $mp3 'tone.mp3'
$procA = (Post-Json "$b/v1/process" @{ file_id = $upA.fileId; processor = 'audio'; options = @{ format = 'ogg'; channels = 1 } }) | ConvertFrom-Json
$jobA = Wait-Job $procA.data.jobId 120
Check 'audio job completed' ($jobA.status -eq 'completed') "status=$($jobA.status) error=$($jobA.error)"

Write-Output "== video lane =="
$upV = Upload $mp4 'tiny.mp4'
$t = (Post-Json "$b/v1/process" @{ file_id = $upV.fileId; processor = 'video'; mode = 'transcode'; options = @{ format = 'mp4'; max_dimension = 64 } }) | ConvertFrom-Json
$jobT = Wait-Job $t.data.jobId 180
Check 'transcode completed' ($jobT.status -eq 'completed') "status=$($jobT.status) error=$($jobT.error)"
$ea = (Post-Json "$b/v1/process" @{ file_id = $upV.fileId; processor = 'video'; mode = 'extract_audio'; options = @{ format = 'mp3' } }) | ConvertFrom-Json
$jobEa = Wait-Job $ea.data.jobId 180
Check 'extract_audio completed' ($jobEa.status -eq 'completed') "status=$($jobEa.status) error=$($jobEa.error)"
$kf = (Post-Json "$b/v1/process" @{ file_id = $upV.fileId; processor = 'video'; mode = 'extract_keyframes'; options = @{ fps = 1 } }) | ConvertFrom-Json
$jobKf = Wait-Job $kf.data.jobId 180
Check 'keyframes completed with a directory' ($jobKf.status -eq 'completed' -and (Test-Path $jobKf.outputPath)) "status=$($jobKf.status) path=$($jobKf.outputPath)"

Write-Output "== sse =="
$s = (Post-Json "$b/v1/process" @{ file_id = $up.fileId; processor = 'image'; options = @{ max_dimension = 32 } }) | ConvertFrom-Json
$events = curl.exe -s -N --max-time 4 "$b/v1/jobs/$($s.data.jobId)/progress"
Check 'SSE emits job events' ("$events" -match 'event: job')

Write-Output "== cancellation =="
$upS = Upload $slow 'slow.mp4'
$c = (Post-Json "$b/v1/process" @{ file_id = $upS.fileId; processor = 'video'; mode = 'transcode'; options = @{ format = 'mkv' } }) | ConvertFrom-Json
Start-Sleep -Seconds 2
$cancel = (curl.exe -s -X DELETE "$b/v1/jobs/$($c.data.jobId)" | ConvertFrom-Json).data
Check 'cancel accepted' ($cancel.status -in 'cancelling', 'cancelled') "status=$($cancel.status)"
$final = Wait-Job $c.data.jobId 60
Check 'job ends cancelled' ($final.status -eq 'cancelled') "status=$($final.status) error=$($final.error)"

Write-Output "== admission bound =="
$burst = 1..6 | ForEach-Object { (Post-Json "$b/v1/process" @{ file_id = $upS.fileId; processor = 'video'; mode = 'transcode'; options = @{ format = 'mkv' } }) | ConvertFrom-Json }
$refused = ($burst | Where-Object { $_.success -eq $false }).Count
Check 'pool refuses beyond capacity' ($refused -ge 1) "refused=$refused of 6"
$burst | Where-Object { $_.success -eq $true } | ForEach-Object { curl.exe -s -X DELETE "$b/v1/jobs/$($_.data.jobId)" | Out-Null }

Write-Output "== tasks adapter =="
$task = (Post-Json "$b/v1/tasks" @{ file_id = $up.fileId; processor = 'image'; options = @{ max_dimension = 40 } }) | ConvertFrom-Json
Check 'task id maps to a job' ([bool]$task.data.taskId)
$taskJob = Wait-Job $task.data.taskId 60
$result = (curl.exe -s "$b/v1/tasks/$($task.data.taskId)/result" | ConvertFrom-Json)
Check 'task result points at the asset' ($result.data.assetId -eq $taskJob.assetId)

Write-Output "== output_path publication =="
$dest = Join-Path $tmp ('published-' + [guid]::NewGuid().ToString('N') + '.png')
$pub = (Post-Json "$b/v1/process" @{ file_id = $up.fileId; processor = 'image'; options = @{ max_dimension = 80 }; output_path = $dest }) | ConvertFrom-Json
$pubJob = Wait-Job $pub.data.jobId 60
Check 'job completed with output_path' ($pubJob.status -eq 'completed') "status=$($pubJob.status) error=$($pubJob.error)"
Check 'caller path was created' (Test-Path $dest) "path=$dest"
Check 'cache asset still referenced' ([bool]$pubJob.assetId)
if (Test-Path $dest) { Check 'published file has bytes' ((Get-Item $dest).Length -gt 100) }

Write-Output "== allowlist =="
$capsCfg = (curl.exe -s "$b/v1/capabilities?section=config" | ConvertFrom-Json).data
$allowAll = ($capsCfg.allowedInputPaths -contains "*")
if ($allowAll) {
    # Not a failure: started without NMEDIA_ALLOWED_* roots, so there is nothing
    # to refuse. Say so rather than reporting a misleading green.
    Write-Output "  skip info allowlist   - service started with allowedInputPaths=*"
    Write-Output "  skip output allowlist - service started with allowedOutputPaths=*"
} else {
    $probe = (curl.exe -s -o NUL -w "%{http_code}" "$b/v1/info/$([uri]::EscapeDataString('C:\Windows\win.ini'))")
    Check 'info refuses a path outside the roots' ($probe -eq '403') "http=$probe"
    $badOut = (Post-Json "$b/v1/process" @{ file_id = $up.fileId; processor = 'image'; options = @{ max_dimension = 20 }; output_path = 'C:\Windows\Temp\nope.png' }) | ConvertFrom-Json
    Check 'output_path outside the roots refused' (-not $badOut.success) "err=$($badOut.error)"
}

Write-Output "== options refused instead of ignored =="
$se = (Post-Json "$b/v1/process" @{ file_id = $up.fileId; processor = 'image'; options = @{ strip_exif = $false } }) | ConvertFrom-Json
Check 'strip_exif:false refused by name' (-not $se.success -and "$($se.error)" -match 'strip_exif')
$q = (Post-Json "$b/v1/process" @{ file_id = $up.fileId; processor = 'image'; options = @{ format = 'png'; quality = 80 } }) | ConvertFrom-Json
Check 'quality on PNG refused by name' (-not $q.success -and "$($q.error)" -match 'quality')
$cc = (Post-Json "$b/v1/process" @{ file_id = $upV.fileId; processor = 'video'; options = @{ cli_command = '-vf scale=10:10' } }) | ConvertFrom-Json
Check 'cli_command refused by name' (-not $cc.success -and "$($cc.error)" -match 'cli_command')

Write-Output "== sse ends on terminal =="
$elapsed = Measure-Command { curl.exe -s -N --max-time 10 "$b/v1/jobs/$($jobT.data.jobId)/progress" | Out-Null }
Check 'terminal job stream ends promptly' ($elapsed.TotalSeconds -lt 5) "elapsed=$([math]::Round($elapsed.TotalSeconds,1))s"

Write-Output "== webp and svg =="
$webpJob = (Post-Json "$b/v1/process" @{ file_id = $up.fileId; processor = 'image'; options = @{ max_dimension = 64; format = 'webp' } }) | ConvertFrom-Json
$wj = Wait-Job $webpJob.data.jobId 60
Check 'webp job completed' ($wj.status -eq 'completed') "status=$($wj.status) error=$($wj.error)"
if ($wj.assetId) {
    $wpath = Join-Path $tmp 'out.webp'
    curl.exe -s "$b/v1/assets/$($wj.assetId)" -o $wpath | Out-Null
    $bytes = [System.IO.File]::ReadAllBytes($wpath)
    $riff = [System.Text.Encoding]::ASCII.GetString($bytes[0..3])
    $webp = [System.Text.Encoding]::ASCII.GetString($bytes[8..11])
    Check 'webp magic bytes are RIFF....WEBP' ($riff -eq 'RIFF' -and $webp -eq 'WEBP') "got $riff/$webp"
}
$svgPath = Join-Path $tmp 'shape.svg'
[System.IO.File]::WriteAllText($svgPath, '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120"><rect width="200" height="120" fill="#3366cc"/><circle cx="100" cy="60" r="40" fill="#ff9900"/></svg>', (New-Object System.Text.UTF8Encoding $false))
$upSvg = Upload $svgPath 'shape.svg'
$svgJob = (Post-Json "$b/v1/process" @{ file_id = $upSvg.fileId; processor = 'image'; options = @{ format = 'png' } }) | ConvertFrom-Json
$sj = Wait-Job $svgJob.data.jobId 60
Check 'svg rendered in-process' ($sj.status -eq 'completed') "status=$($sj.status) error=$($sj.error)"
if ($sj.assetId) {
    $m = (curl.exe -s "$b/v1/assets/$($sj.assetId)/metadata" | ConvertFrom-Json).data
    Check 'svg rasterised at its own size' ($m.width -eq 200 -and $m.height -eq 120) "meta=$($m | ConvertTo-Json -Compress)"
}

Write-Output ""
Write-Output "passed=$pass failed=$fail"
if ($fail -gt 0) { exit 1 }
