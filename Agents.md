# Media Service - Agent Overview

## Purpose

Media Service is a stateless microservice designed to preprocess multimedia files for Large Language Model (LLM) consumption. It acts as an optimization sidecar service that receives large files and returns downscaled, compressed, LLM-friendly versions. Utilizes GPU acceleration when available (NVENC, VAAPI, QSV).

## Documentation

| Document | Location | Purpose |
|----------|----------|---------|
| Configuration | `config.json` | All configuration settings (server, media, logging, cache, workers) |
| Specification | `docs/media_service_spec.md` | Detailed technical specification, API design, architecture |
| Development Plan | `docs/media_service_dev_plan.md` | Implementation roadmap, technology choices, development phases |

## Configuration

All configuration is managed via `config.json` in the project root. No `.env` defaults are used. The config loader throws on missing required values - this is intentional.

Required fields:
- `server.port`
- `logging.logsDir`
- `media.gpu.platform`

## Logging

Logs are stored in `/logs` (configurable via `config.json`). nLogger creates:
- **Session logs**: `{timestamp}-{sessionPrefix}-{randomId}.log` - detailed logs for each session
- **Main logs**: `main-{n}.log` - rolling logs combining all sessions (JSON Lines format)

**Primary location for recent logs:** `/logs`

## Testing

Test assets are located in `/tests/assets/`:

| Directory | Contents |
|-----------|----------|
| `tests/assets/images/` | PNG, JPG, HEIC, CR2 (Canon RAW), ORF (Olympus RAW), GIF |
| `tests/assets/audio/` | MP3, M4A, WAV, FLAC, OGG |
| `tests/assets/videos/` | MP4, MOV |

### Test Files
| File | Purpose |
|------|---------|
| `tests/index.js` | Unit test runner (processors) |
| `tests/ws-integration-test.js` | WebSocket end-to-end test (spawns service, tests WS upload/process/download) |
| `tests/e2e.test.js` | Legacy HTTP E2E tests (**outdated**, needs update for unified transport) |
| `tests/manual-readme-test.js` | Manual nVideo transcoding test |

## Core Development Maxims
- **Priorities:** Reliability > Performance > Everything else.
- **LLM-Native Codebase:** Code readability and structure for *humans* is a non-goal. The code will not be maintained by humans. Optimize for the most efficient structure an LLM can understand. Do not rely on conventional human coding habits.
- **Vanilla JS:** No TypeScript anywhere. Code must stay as close to the bare platform as possible for easy optimization and debugging. `.d.ts` files are generated strictly for LLM/editor context, not used at runtime.
- **Zero Dependencies:** If we can build it ourselves using raw standard libraries, we build it. Avoid external third-party packages. Evaluate per-case if a dependency is truly necessary.
- **Fail Fast, Always:** No defensive coding. No mock data. No fallback defaults. No silencing `try/catch`. No optional chaining (`?.`) for required values. Configuration must be explicit - missing required config must throw immediately at startup. When something breaks, let it crash and fix the root cause.

## Service Management
- **Do Not Start/Restart Service:** Never start, restart, or stop the Media Service on your own. If the service needs to be started or restarted, ask the user to do it.

## Development Environment
- **FiveServer Live Reload:** The health check endpoint (`/health`) writes to `/logs` on every call. FiveServer's file watcher detects these log writes and triggers constant page reloads. This is resolved by `fiveserver.config.cjs` which ignores `/logs/` and `/cache/` directories. If live reload loops occur, verify the config exists and restart FiveServer.

## Bundled Submodules

This project uses git submodules located in `/modules`. These are all **our own projects** and can be enhanced if needed:

| Submodule | Purpose |
|-----------|---------|
| `modules/nLogger` | Structured logging |
| `modules/nImage` | Native image processing (RAW, HEIC, 150+ formats) |
| `modules/nVideo` | Native audio/video processing (direct FFmpeg library integration) |
| `modules/nui_wc2` | Web UI for monitoring/testing |

**Important:** Before modifying any submodule code, ask the user for permission. Changes to submodules affect other projects that depend on them.

## Architecture

### Components

#### PipelineExecutor (`src/pipeline/PipelineExecutor.js`)
- Singleton registry for media processors
- Routes processing requests to the appropriate processor
- Coordinates progress reporting

#### Processors (extending `src/pipeline/Processor.js`)

| Processor | Technology | Capabilities |
|-----------|------------|--------------|
| ImageProcessor | nImage (native NAPI) | Resize, format conversion, cropping (region/center/grid), EXIF stripping. Supports RAW, HEIC, and 150+ formats |
| AudioProcessor | nVideo (native NAPI) | Resampling (8-48kHz), channel conversion, format conversion (mp3/wav/ogg/m4a). Direct FFmpeg library integration. |
| VideoProcessor | nVideo (native NAPI) | Audio extraction, keyframe extraction at configurable FPS. Direct FFmpeg library integration. |

#### nVideo Native Module (`modules/nVideo/`)
- Direct FFmpeg C API integration (no CLI spawning)
- File-to-file transcoding runs entirely in C++
- Audio filter graphs (`abuffer → aformat → asetnsamples → abuffersink`)
- Native progress callbacks (percent, speed, bitrate, ETA)
- Automatic GPU codec selection based on `config.media.gpu.platform`
- SHA256-based caching with transmit-once TTL

**GPU Platforms:**
| Platform | Video Decode | Video Encode |
|----------|--------------|--------------|
| `nvenc` | h264_cuvid, hevc_cuvid | h264_nvenc, hevc_nvenc |
| `vaapi` | h264_vaapi, hevc_vaapi | h264_vaapi, hevc_vaapi |
| `qsv` | h264_qsv, hevc_qsv | h264_qsv, hevc_qsv |
| `cpu` | software | libx264, libx265 |

#### ProgressReporter (`src/pipeline/ProgressReporter.js`)
- Manages progress connections for real-time updates
- Supports both **SSE** and **WebSocket** via generic `Sender` interface
- Provides job lifecycle events: `start`, `progress`, `complete`, `error`, `cancelled`
- Supports linking external connection IDs to internal job IDs

#### WebSocket Server (`src/server/WebSocketServer.js`)
- Raw Node.js WebSocket implementation (no external `ws` dependency)
- Mounted on `/v1/ws`
- Supports:
  - Progress subscription (`subscribe` / `unsubscribe`)
  - Binary upload (`upload_start` → binary chunks → `upload_complete`)
  - Binary download (`download_request` → file streamed in binary frames)
  - Ping/pong heartbeat

#### API Routes (`src/api/routes/`)
- **Unified transport** (recommended):
  - `POST /v1/upload` - raw binary upload
  - `POST /v1/process` - start processing from `fileId` or `input_path`
  - `GET /v1/jobs/:jobId/progress` - SSE progress stream
  - `GET /v1/jobs/:jobId` - polling fallback
  - `DELETE /v1/jobs/:jobId` - cancellation
  - `WS /v1/ws` - WebSocket progress + binary transfer
- **Legacy endpoints** (still functional but deprecated):
  - `POST /v1/process/image`, `/v1/process/audio`, `/v1/process/video`

### Key Processing Options

**Images:**
- `max_dimension`: Longest edge constraint (default 1024px)
- `quality`: Output quality 1-100 (default 85)
- `format`: jpeg/png/webp/avif/gif
- `crop`: region (normalized coords), center (% of image), grid (cell extraction)

**Audio:**
- `sample_rate`: 8000/16000/22050/44100/48000 Hz (default 16000 for STT)
- `channels`: 1 (mono) or 2 (stereo), default mono
- `format`: mp3/wav/ogg/m4a

**Video:**
- `mode`: extract_audio or extract_keyframes
- `fps`: Frame rate for keyframe extraction (1-30)
- `max_dimension`: Max frame dimension

## Task System

The task system handles asynchronous processing:

- **TaskManager** (`src/tasks/TaskManager.js`) - Singleton coordinator
- **TaskQueue** (`src/tasks/TaskQueue.js`) - FIFO queue with concurrency control
- **Worker** (`src/tasks/Worker.js`) - Processes tasks via PipelineExecutor
- **TaskWorker** (`src/tasks/TaskWorker.js`) - Worker thread bootstrap (thread mode)
- **AssetCache** (`src/cache/AssetCache.js`) - Stores results with TTL
- **JobStore** (`src/jobs/JobStore.js`) - Disk-backed job persistence and upload tracking

### Worker Execution Modes

Configured via `workers.mode` in `config.json`:

| Mode | Behavior | Use Case |
|------|----------|----------|
| `thread` (default) | Each task spawns a `worker_thread` | True parallelism, protects main process from native panics |
| `queue` | Tasks run on main thread, serialized by queue | Memory-constrained, simpler |

**Thread mode is strongly recommended** for audio/video. A native module panic in nVideo will kill only the worker thread, not the main process.

### Audio/Video Processing Flow

```
1. Client uploads file via POST /v1/upload (or provides input_path)
2. Server writes input to temp file in cache dir
3. Task queued → Worker picks up (thread mode spawns worker_thread)
4. nVideo processes: input → output (all in C++ memory)
5. Output stored in AssetCache
6. Input temp file deleted
7. SSE / WS progress updates sent
8. Client downloads result from /v1/assets/:id
9. Asset marked as retrieved (TTL = 0)
```

## Data Flow

1. Client sends raw binary to `POST /v1/upload` **or** provides `input_path` to `POST /v1/process`
2. Route handler validates input (magic bytes, path allowlist)
3. `POST /v1/process` returns `jobId` immediately
4. Client subscribes to progress via SSE (`/v1/jobs/:jobId/progress`) or WebSocket (`/v1/ws`)
5. PipelineExecutor routes to appropriate processor
6. Processor performs transformation with native progress callbacks
7. Result stored in AssetCache; `complete` event includes `assetId`
8. Client downloads from `/v1/assets/:assetId`

## Error Handling Contract

| HTTP Status | Meaning | Gateway Action |
|-------------|---------|----------------|
| 200 | Success | Swap payload |
| 202 | Accepted (async task queued) | Poll for result |
| 413 | File too large | Return error to client |
| 415 | Unsupported format | Pass-through original |
| 5XX | Processing error | Circuit breaker trips, bypass MPS |

## Recent Fixes & Notes

### Upload Handler `end`/`close` Race
Fixed in `src/api/routes/upload.js`: the `rawRequest` `close` event was destroying the write stream after the `end` event had already fired, causing uploads to hang indefinitely. A `requestEnded` flag now prevents this.

### Progress Completion & assetId
`PipelineExecutor.execute()` sends a `complete` progress event before caching. `Worker.js` now sends a follow-up `complete` event with the actual `assetId` after caching. WS/SSE clients should wait for the event containing `assetId`.

### ESM Worker Loading
Native modules are loaded in worker threads via `createRequire(import.meta.url)` because ESM `worker_threads` does not support direct `require()`.

## LLM Integration Notes

- Images are downscaled to reduce token count while preserving visual fidelity
- Audio is resampled to 16kHz mono (optimal for Whisper/STT models)
- Video processing extracts either audio track or keyframes for analysis
- EXIF stripping removes potentially sensitive metadata
- All output formats are widely supported by LLM vision/audio models
