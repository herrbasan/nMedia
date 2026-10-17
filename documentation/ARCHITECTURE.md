# nMedia Architecture

## Overview

nMedia is a Node.js microservice that preprocesses multimedia files for LLM consumption. It uses native NAPI modules (nImage, nVideo) for GPU-accelerated image, audio, and video processing.

## Component Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        nMedia                             │
│                        (Node.js)                                │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │ HTTP Server │  │ Task Queue  │  │   Messaging Layer       │  │
│  │  (native)   │  │ (In-Memory) │  │ (SSE + WebSocket)       │  │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘  │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │                    Native Processors                        │  │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │  │
│  │  │ Image       │  │ Audio       │  │ Video               │  │  │
│  │  │ (nImage)    │  │ (nVideo)    │  │ (nVideo)            │  │  │
│  │  └─────────────┘  └─────────────┘  └─────────────────────┘  │  │
│  └─────────────────────────────────────────────────────────────┘  │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │                    Asset Cache + Job Store                  │  │
│  │               (Disk + TTL management + Persistence)         │  │
│  └─────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

## Core Components

### PipelineExecutor

**Location:** `src/pipeline/PipelineExecutor.js`

Singleton registry for media processors. Routes processing requests to the appropriate processor and coordinates progress reporting.

```javascript
// Registration
PipelineExecutor.register('image', new ImageProcessor());
PipelineExecutor.register('audio', new AudioProcessor());
PipelineExecutor.register('video', new VideoProcessor());

// Execution
const result = await PipelineExecutor.execute('audio', input, options, onProgress);
```

### Processors

All processors extend `src/pipeline/Processor.js` and implement:

| Method | Description |
|--------|-------------|
| `validateOptions(options)` | Validate processing options, throw on invalid |
| `process(input, options, onProgress)` | Main processing method |
| `probe(input)` | (Optional) Extract metadata before processing |

#### ImageProcessor

**Location:** `src/processors/image/ImageProcessor.js`

Uses nImage (native NAPI with libraw/libheif/ImageMagick support).

**Capabilities:**
- Resize with max dimension constraint
- Format conversion (JPEG, PNG, WebP, AVIF, GIF)
- Quality adjustment (1-100)
- EXIF stripping
- Region/center/grid cropping

**Input formats:** RAW (CR2, NEF, ARW, ORF, DNG, etc.), HEIC/HEIF/AVIF, 150+ formats via ImageMagick

#### AudioProcessor

**Location:** `src/processors/audio/AudioProcessor.js`

Uses nVideo (native NAPI with direct FFmpeg library integration).

**Capabilities:**
- Sample rate conversion (8k-48k Hz)
- Channel conversion (mono/stereo)
- Format conversion (MP3, WAV, OGG, M4A, FLAC, AAC, Opus)
- Audio probing (metadata extraction)

**Processing flow:**
1. Probe input for source metadata
2. Transcode with audio filter graph: `abuffer → aformat → asetnsamples → abuffersink`
3. Return processed audio

#### VideoProcessor

**Location:** `src/processors/video/VideoProcessor.js`

Uses nVideo for all video operations.

**Processing modes:**

| Mode | Description | Implementation |
|------|-------------|----------------|
| `extract_audio` | Extract audio track | FFmpeg CLI (`-vn -c:a ...`) via `nVideo.transcode()` |
| `extract_keyframes` | Extract frames at FPS | Native `nVideo.thumbnail()` loop + nImage JPEG |
| `transcode` | Full video transcode | FFmpeg CLI via `nVideo.transcode({ cli_command: ... })` |

**GPU codec selection** — codecs must be explicitly specified in options; no auto-injection occurs:

| Platform | Video Decode | Video Encode |
|----------|--------------|--------------|
| `nvenc` | h264_cuvid, hevc_cuvid | h264_nvenc, hevc_nvenc, av1_nvenc |
| `vaapi` | h264_vaapi, hevc_vaapi | h264_vaapi, hevc_vaapi |
| `qsv` | h264_qsv, hevc_qsv | h264_qsv, hevc_qsv, av1_qsv |
| `cpu` | software | libx264, libx265, libsvtav1 |

### ProgressReporter

**Location:** `src/pipeline/ProgressReporter.js`

Transport-agnostic progress management via generic `Sender` interface.

**Supported transports:**
- SSE (`SseConnection`)
- WebSocket (`WebSocketConnection`)

**Job lifecycle events:**
1. `start` - Processing begun
2. `progress` - Percent complete with message
3. `complete` - Finished with assetId
4. `error` - Processing failed

### WebSocket Server

**Location:** `src/server/WebSocketServer.js`

Raw Node.js WebSocket implementation (no external `ws` dependency).

**Endpoint:** `/v1/ws`

**Features:**
- Progress subscription (`subscribe` / `unsubscribe`)
- Binary upload (`upload_start` → binary chunks → `upload_complete`)
- Binary download (`download_request` → file streamed in binary frames)
- Ping/pong heartbeat

### JobStore

**Location:** `src/jobs/JobStore.js`

Disk-backed job and upload persistence with startup recovery.

**Storage layout:**
- `cache/jobs/jobs.json` — persisted jobs, uploads, uploadToJob mapping, nextQueuePosition
- `cache/uploads/` — raw uploaded temp files

**Job lifecycle:**
```
queued → processing → completed/failed/cancelled
```

**Startup recovery:**
1. Load persisted jobs and uploads from JSON
2. Jobs in `processing` state marked `failed` ("Service restarted during processing")
3. Jobs in `queued` remain queued (will be re-processed)

**Cleanup (every 5 minutes):**
- **Uploads deleted when:**
  - Unprocessed and expired (> 1h)
  - Processed and job completed/failed/cancelled > 1h ago
  - Processed but job no longer exists
  - Older than 24h (safety net)
- **Jobs deleted when:** completed/failed/cancelled > 1h ago
- **Orphan cleanup:** Files in `cache/uploads/` not tracked in uploads Map are deleted

**ID chain:** `fileId` (upload) → `jobId` (process) → `assetId` (result)

### AssetCache

**Location:** `src/cache/AssetCache.js`

Disk-backed asset storage with TTL management, LRU eviction, and JSON persistence.

**Storage layout:**
- `cache/assets/assets.json` — metadata persistence
- `cache/assets/{uuid}.{ext}` — asset files

**TTL behavior:**
- New assets get `expiresAt = now + ttl` (default 1 hour)
- On first download (`markRetrieved`), `expiresAt` set to `now` (expire immediately)
- Cleanup runs every 5 minutes, deleting expired assets

**Persistence:**
- Metadata persisted to `cache/assets/assets.json` on every mutation
- On startup: loads metadata, deletes orphaned files, recalculates `currentSize`

**LRU eviction:**
- Triggered when `currentSize > maxSize`
- Evicts least-recently-accessed assets until below 80% of max
- Logs each eviction with asset ID, type, size

## Worker Execution Modes

Configured via `workers.mode` in `config.json`:

| Mode | Behavior | Use Case |
|------|----------|----------|
| `queue` | Tasks run on main thread via `PipelineExecutor`, serialized by queue | Memory-constrained, simpler debugging |
| `thread` | Each task spawns a `worker_thread` | True parallelism, lighter than process mode |
| `process` | Each task spawns a `child_process.fork` | Maximum isolation — native crashes don't affect main process or other workers |

**Process mode is strongly recommended** for audio/video. A native module panic in nVideo will kill only the child process, not the main process or other workers.

Queue slot accounting: a task's slot is released from the worker's `finally` block, after
`activeTask` is cleared. Releasing it from the completion path let the follow-up dispatch
look for an idle worker while the finishing worker was still marked busy — that failed the
queued task, stranded its job record and permanently shrank the pool (issue #1).
`TaskQueue` also releases the slot when a processor rejects before a worker settles.
`enqueue()` resolves when the task is accepted (started or queued), not when it starts, so
a saturated queue does not delay the `POST /v1/process` response.

## Logging

Logging is provided by the bundled `nLogger` submodule. `src/utils/logger.js` creates
the singleton and adds one convention on top of it.

**nLogger's error signature is `error(message, error, meta, type)`.** Passing a meta
object as the second argument silently drops every field — that is why the logs used to
show `{"error":"..."}` with no context or stack. Always use the `logError` facade:

```js
import { logError } from '../utils/logger.js';

logError('Image processing failed', error, { requestId, inputBytes, options });
```

`logError` passes the stack as an array of lines because nLogger truncates metadata
strings longer than 500 characters to 200, which would reduce a stack trace to its
message and one frame.

Rules:

- Log the failure where it happens, with the ids and inputs needed to reproduce it:
  `requestId`, `jobId`, `taskId`, `fileId`, `path`, option values, byte counts.
- `Context.error()` logs 4xx at WARN and 5xx at ERROR; 4xx is a client error, not a
  service fault.
- Never swallow a caught error. Rethrow it, or log at a level matching its severity.
  Temporary-file cleanup (`catch {}` around `unlinkSync`) is the only silent case.
- Processors, workers and routes may add context at each layer; the origin log carries
  the stack.
- `logger.close()` must run before `process.exit()` — the main log is buffered and
  would otherwise lose its last lines.

Each HTTP request produces one completion line:

```
[2026-10-17T04:28:37.775Z] [INFO] [System] POST /v1/process/image 200 123ms {"requestId":"..."}
```

Aborted requests log at WARN (`... aborted after 5000ms`). `requestId` correlates the
request line with handler and processor error logs.

Worker error reporting:

- `process` mode pipes child stdout/stderr. The last 4000 characters of stderr are
  captured and logged on a non-zero exit — the only diagnostic a native crash leaves.
- The child reports `{ type: 'error', message, stack }`. Uncaught exceptions and
  unhandled rejections are reported the same way before the child exits.

**Log levels.** `logging.level` sets the minimum level written (`debug`, `info`,
`warn`, `error`); ERROR always passes the gate. The level is applied through
`logger.setLevel()` at startup, so the value in `config.json` is authoritative — the
`LOG_LEVEL` environment variable only supplies nLogger's default before that call.

**Log and cache paths resolve against the project root**, not the process working
directory. Starting the service from `src/` and from the repository root both write to
`<project>/logs` and `<project>/cache`.

## Graceful Shutdown

The service handles `SIGTERM` and `SIGINT` signals for clean shutdown:

1. HTTP server stops accepting new connections
2. All WebSocket connections are closed with `1001 Going Away`
3. Task manager stops accepting new tasks
4. Asset cache and job store cleanup intervals are cleared
5. Job state is persisted to disk
6. Log streams are flushed and closed (`logger.close()`)
7. Process exits with code 0

## Processor Self-Check

At startup, after the processors are registered, `src/processors/health.js` calls
`nImage.selfCheck()` and verifies each backend against a 1×1 PNG fixture:

| Backend | Check |
|---------|-------|
| sharp / native | decode → resize → re-encode the fixture |
| ImageMagick | decode the fixture through `dist/magick.exe`, using the same extensionless temp-file shape as the real fallback |
| SVG | launch Chrome/Edge and rasterize a 2×2 SVG (the browser is left warm) |
| nVideo | `getBuildInfo()` on the native module |

The results are logged once (`Processor ready: …` / `Processor unavailable: …`) and
cached for the lifetime of the process:

- `GET /health` serves the snapshot: overall status, per-processor state, backend
  details and `checkedAt`. It does not re-probe on each request.
- `GET /v1/capabilities` embeds the same `health` object.
- `POST /v1/process` returns **503** when the requested processor failed its check,
  instead of queueing a job that cannot succeed.

A processor is unavailable only when its **core** backend fails (sharp for image, the
native module for audio/video). A failing auxiliary backend — ImageMagick coders or the
SVG browser — is reported in `/health` and `/v1/capabilities` but does not block the
standard raster path, which does not use them. The self-check never throws; each backend
reports `{ ok, error? }`.

## Configuration Validation

At startup, `config.js` validates all required fields and throws immediately if any are missing:

| Required Field | Description |
|----------------|-------------|
| `server.port` | HTTP server port |
| `logging.logsDir` | Log directory path (relative to the project root) |
| `logging.level` | Log level: debug, info, warn, error |
| `media.gpu.platform` | GPU platform: nvenc, vaapi, qsv, cpu |
| `media.maxFileSizeMb` | Maximum upload size (MB) |
| `cache.dir` | Asset cache directory (relative to the project root) |
| `cache.ttl` | Asset cache TTL (seconds) |
| `cache.maxSize` | Max cache size (bytes) |
| `workers.mode` | Worker execution mode: `queue`, `thread`, or `process` |
| `workers.maxConcurrentTasks` | Max concurrent workers |

No defaults are provided for required fields — explicit configuration is mandatory.

## Data Flow

### Upload + Process Flow

```
1. Client → POST /v1/upload (raw binary stream)
            ↓
        Server writes to temp file, validates magic bytes
            ↓
        Returns { fileId }

2. Client → POST /v1/process { fileId, processor, options }
            ↓
        Returns { jobId, status: "queued" }

3. Client subscribes to progress:
       SSE: GET /v1/jobs/:jobId/progress
       WS:  Send { type: "subscribe", jobId } over /v1/ws
            ↓
        Server sends start/progress/complete events

4. On complete, event includes assetId
            ↓
5. Client → GET /v1/assets/:assetId
            ↓
        Asset marked as retrieved (TTL = 0)
```

### Path-Based Processing Flow

```
1. Client → POST /v1/process { input_path, processor, options }
            ↓
        Path validated against allowlist, fs.access() checked
            ↓
        Returns { jobId, status: "queued" }

2. Progress and retrieval identical to upload flow
```

## Security

### Path Validation
- `input_path` must start with a prefix from `config.media.allowedInputPaths`
- Pre-flight `fs.access(path, fs.constants.R_OK)` check before queuing
- UNC paths blocked unless explicitly allowed

### Upload Resource Management
- `Content-Length` header required for pre-flight disk space check
- Upload concurrency limited by config
- Partial uploads cleaned up on connection abort
- Magic byte validation after upload completes

### GPU Slot Management
- NVENC has max concurrent sessions (3-5 on consumer cards)
- Configurable via `media.gpu.maxConcurrentSessions`
