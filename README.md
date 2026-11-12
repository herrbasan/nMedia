# nMedia

Media processing service: images, audio, video, HEIC and SVG over HTTP, with
durable jobs, a cached asset store and capability introspection a caller can
trust.

It replaces the earlier Node implementation of the same service. The HTTP
contract is unchanged — the same endpoints, the same `{ success, data }`
envelopes, the same option keys — so existing consumers did not move.

## Run

```bash
cargo build --release
cp config.example.json config.json      # then edit the paths
target/release/nmedia-server.exe
```

Listens on `127.0.0.1:3500` by default (`config.json` → `server.port`).

## Configuration

`config.json` is read from `NMEDIA_CONFIG` or `./config.json`. **Every key can be
overridden by environment**, so a process manager can drive the service without a
file:

| Setting | Config | Environment |
|---|---|---|
| port / host | `server.port`, `server.host` | `NMEDIA_PORT`, `NMEDIA_HOST` |
| upload ceiling | `media.maxFileSizeMb` | `NMEDIA_MAX_FILE_MB` |
| path allowlists | `media.allowedInputPaths`, `allowedOutputPaths` | `NMEDIA_ALLOWED_INPUT`, `NMEDIA_ALLOWED_OUTPUT` |
| engines | `media.ffmpegPath`, `media.chromePath` | `NMEDIA_FFMPEG`, `NMEDIA_FFPROBE`, `NMEDIA_CHROME`, `NMEDIA_CHROME_DIR` |
| cache | `cache.dir`, `cache.ttl`, `cache.maxSize` | `NMEDIA_CACHE_DIR`, `NMEDIA_CACHE_TTL`, `NMEDIA_CACHE_MAX_BYTES` |
| workers | `workers.maxConcurrentTasks` | `NMEDIA_WORKERS` |
| logging | `logging.level`, `logsDir`, `retentionDays` | `LOG_LEVEL`, `LOG_RETENTION_DAYS` |

Unknown keys — top level or inside a section — are reported at startup. Nothing
is accepted and silently ignored.

## Engines

Nothing is reimplemented that a mature engine already does:

| Work | Engine |
|---|---|
| images | the `image` crate, `fast_image_resize` (SIMD), `image-webp` |
| audio, video, HEIC | **ffmpeg** as a child process — your own build if you point `media.ffmpegPath` at it |
| SVG | **Chromium** (exact: CSS variables, media queries, font weights) or `resvg` in-process (`engine: "resvg"`, approximate) |

### The browser is ours, not the host's

nMedia ships its own Chromium. `scripts/fetch-browser.ps1` downloads
`chrome-headless-shell` from Chrome for Testing, records the version and SHA-256 in
`runtime/browser.lock.json`, and extracts it to `runtime/`. That artifact is the
engine; it is fetched rather than committed, and the lock refuses a download whose
hash disagrees with the recorded one.

Resolution order, published as `backends.chromeSource` in `/health`:

1. `NMEDIA_CHROME` (explicit executable) or `NMEDIA_CHROME_DIR` — `configured`
2. `runtime/chrome-headless-shell-*/`, `runtime/chrome-*/` beside the binary — `bundled`
3. an installed Chrome/Edge, then `chrome` on `PATH` — `system`

The bundled engine sits ahead of the system one on purpose: a deployment must render
with the version it was tested against, not with whatever the host updated to
overnight. The version string is probed at startup and reported; `resvg` is the
fallback only when no browser resolves at all.

Buffered request bodies are capped at the file ceiling plus one third — base64
costs 4 bytes per 3 raw — so legacy inline processing keeps working for large
media. `/v1/capabilities?section=config` publishes the exact number as
`maxBodyBytes`; uploads stream and enforce `media.maxFileSizeMb` themselves.

`GET /v1/capabilities` reports what the binary in front of it can actually do:
ffmpeg version, hwaccels, filter count, and the encoder for each codec with
hardware first (`h264_nvenc` before `libx264`).

## API

Modern:

```
GET  /health                      readiness, engine identity, config source
GET  /v1/capabilities             formats, limits, engines, encoders, retention
POST /v1/upload                   raw body + X-Original-Filename -> fileId
POST /v1/process                  {fileId|input_path, processor, mode?, options?} -> jobId
GET  /v1/jobs, /v1/jobs/active, /v1/jobs/:id, DELETE /v1/jobs/:id
GET  /v1/jobs/:id/progress        SSE; closes on the terminal event
GET  /v1/assets, /v1/assets/:id, /v1/assets/:id/metadata, DELETE
GET  /v1/thumbnail/*path, /v1/info/*path
```

Legacy (kept because consumers still use them — a different contract, see
`Agents.md`):

```
POST /v1/process/image      { base64, format, max_dimension?, quality?, response_type? }
                            -> { success, base64, format, width, height }
POST /v1/process/image/crop { base64, crop:{left,top,right,bottom}, ... }
                            -> { success, crops: [ { base64, format, width, height } ] }
POST /v1/process/audio, /v1/process/video, /v1/audio/probe, /v1/video/probe
GET/POST/DELETE /v1/tasks*   adapter over the job store
GET  /v1/ws                  501 — progress travels over SSE
```

## Logs

Written to the ecosystem convention (`documentation/The Project/infra_nlogger.md`
in MCP storage): `logs/main-0.log` as JSONL rolling at 10 MB into `main-1..9`,
plus `logs/<session>.log` in human form. Stdout carries the same events, so a
process manager capture and the files agree.

## Tests

```powershell
powershell -NoProfile -File tests\compat.ps1     # 37 checks against a running service
```

`tests/render-charts.ps1` renders storage SVGs through both SVG engines;
`tests/convert-to-testdir.ps1` converts files into a scratch directory with
timings.
