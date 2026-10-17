# nMedia - Agent Overview

## Purpose

nMedia is a stateless microservice designed to preprocess multimedia files for Large Language Model (LLM) consumption. It acts as an optimization sidecar service that receives large files and returns downscaled, compressed, LLM-friendly versions. Utilizes GPU acceleration when available (NVENC, VAAPI, QSV).

## Documentation

### Working Documents (`/docs`)

Internal working documents for planning and specification.

| Document | Location | Purpose |
|----------|----------|---------|
| Configuration | `config.json` | All configuration settings (server, media, logging, cache, workers) |
| Specification | `docs/nMedia_Spec.md` | Detailed technical specification, API design, architecture |
| Development Plan | `docs/nMedia_Dev_plan.md` | Implementation roadmap, technology choices, development phases |

### Project Documentation (`/documentation`)

Proper documentation for the project, similar in style to nImage and nVideo module docs.

| Document | Location | Purpose |
|----------|----------|---------|
| API Reference | `documentation/README.md` | Main API documentation, quick start, endpoints |
| Architecture | `documentation/ARCHITECTURE.md` | Component overview, data flow, security |
| Capabilities | `documentation/CAPABILITIES.md` | Capabilities endpoint full reference |
| Processing | `documentation/PROCESSING.md` | Processing workflows, native module details |

**Note:** `/docs` is for working documents (specs, plans, drafts). `/documentation` is for the proper, published documentation of the project.

## Configuration

All configuration is managed via `config.json` in the project root. Copy `config.example.json` to `config.json` and adjust paths for your environment. The config loader throws on missing required values — this is intentional. No `.env` files are used.

Required fields:
- `server.port`
- `logging.logsDir`
- `logging.level` (debug, info, warn, error)
- `media.gpu.platform`

## Logging

Logs are stored in `/logs` (configurable via `config.json`). nLogger creates:
- **Session logs**: `{timestamp}-{sessionPrefix}-{randomId}.log` - detailed logs for each session
- **Main logs**: `main-{n}.log` - rolling logs combining all sessions (JSON Lines format)

**Primary location for recent logs:** `/logs` (project root)

`logging.logsDir` and `cache.dir` are resolved against the project root, not the process
working directory. Logs written before 2026-10-17 by a service started from `src/` are in
`src/logs/`.

`logging.level` is the minimum level written (errors always pass). Levels are applied via
nLogger's `setLevel()` at startup.

Use `logError(message, error, meta)` from `src/utils/logger.js` for every failure.
nLogger's `error()` signature is `(message, error, meta, type)`; passing a meta object as
the second argument drops the metadata and the stack. Full convention:
`documentation/ARCHITECTURE.md` → Logging.

## Testing

`npm test` runs the suite with Node's built-in test runner
(`node --test "tests/**/*.test.js"`). No third-party runner is involved.

### Test Files
| File | Purpose |
|------|---------|
| `tests/logger.test.js` | Log-level filtering, unknown-level rejection, `logError` stack/metadata retention |

The processor and end-to-end suites referenced by `package.json`'s `test:e2e*` scripts
(`tests/ws-integration-test.js`, `tests/e2e.test.js`, `tests/manual-readme-test.js`) and
the media fixtures in `tests/assets/` are **not present in the repository**. They must be
restored before those scripts can run.

## Core Development Maxims
- **Priorities:** Reliability > Performance > Everything else.
- **LLM-Native Codebase:** Code readability and structure for *humans* is a non-goal. The code will not be maintained by humans. Optimize for the most efficient structure an LLM can understand. Do not rely on conventional human coding habits.
- **Vanilla JS:** No TypeScript anywhere. Code must stay as close to the bare platform as possible for easy optimization and debugging. `.d.ts` files are generated strictly for LLM/editor context, not used at runtime.
- **Zero Dependencies:** If we can build it ourselves using raw standard libraries, we build it. Avoid external third-party packages. Evaluate per-case if a dependency is truly necessary.
- **Fail Fast, Always:** No defensive coding. No mock data. No fallback defaults. No silencing `try/catch`. No optional chaining (`?.`) for required values. Configuration must be explicit - missing required config must throw immediately at startup. When something breaks, let it crash and fix the root cause.
- **Collaborative Development:** The human user is a partner, not just a reviewer. When facing architectural decisions, trade-offs, or uncertain paths, pause and ask for input. Explain the options clearly. The user's domain knowledge and preferences are valuable — include them in the loop. Avoid long silent stretches of trial-and-error; converse, don't just execute.

## Service Management
- **Do Not Start/Restart Service:** Never start, restart, or stop nMedia on your own. If the service needs to be started or restarted, ask the user to do it.

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
| ImageProcessor | nImage (native NAPI) | Resize, format conversion, cropping (region/center/grid), EXIF stripping. Supports RAW, HEIC, SVG/SVGZ (rasterized by headless Chrome), and 150+ formats |
| AudioProcessor | nVideo (native NAPI) | Resampling (8-48kHz), channel conversion, format conversion (mp3/wav/ogg/m4a). Direct FFmpeg library integration. |
| VideoProcessor | nVideo (native NAPI) | Audio extraction, keyframe extraction, full transcode, CLI passthrough. Direct FFmpeg library integration. |

#### nVideo Native Module (`modules/nVideo/`)
- Direct FFmpeg C API integration (no CLI spawning)
- File-to-file transcoding runs entirely in C++
- Audio filter graphs (`abuffer → aformat → asetnsamples → abuffersink`)
- Native progress callbacks (percent, speed, bitrate, ETA)
- SHA256-based caching with transmit-once TTL
- GPU codec must be explicitly specified in options; no automatic selection occurs

**GPU Platforms:**
| Platform | Video Decode | Video Encode |
|----------|--------------|--------------|
| `nvenc` | h264_cuvid, hevc_cuvid | h264_nvenc, hevc_nvenc, av1_nvenc |
| `vaapi` | h264_vaapi, hevc_vaapi | h264_vaapi, hevc_vaapi |
| `qsv` | h264_qsv, hevc_qsv | h264_qsv, hevc_qsv, av1_qsv |
| `cpu` | software | libx264, libx265, libsvtav1 |

> **⚠️ Hardware-Accelerated Encoding Warning:** HW encode (NVENC, QSV, VAAPI) is **experimental and currently crashes** with `0xC0000005` (access violation). See `docs/handover_2026-04-22.md` for details. **Software encoding (`libx264`, `libx265`, `libsvtav1`) is reliable and recommended.**

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
- `crop`: region (`left`/`top`/`right`/`bottom` normalized coords 0-1), center (`width`/`height` % of image), grid (`cols`/`rows` + `cells` array)
- `rotate`: 90, 180, or 270
- `flip`: vertical flip
- `flop`: horizontal flip
- `grayscale`: convert to grayscale
- `normalize`: normalize contrast
- `blur`: blur sigma 0-20

**SVG input (`svg`, `svgz`):**
- Rasterized by a persistent headless Chrome/Edge inside nImage, then processed like any other decoded image — resize, crop, format conversion and `strip_exif` all apply to the result
- **Operational requirement: Chrome or Edge must be installed on the host.** Nothing ships a browser. Missing → the job fails loudly, never a silent fallback. Override the binary with `NIMAGE_CHROME_PATH`
- Why a browser: librsvg (sharp's SVG backend) and resvg both silently drop CSS custom properties, and this ImageMagick build has no SVG support at all. Chrome is the only available renderer that resolves `var()`, `@media (prefers-color-scheme)`, `rgba()` in stylesheets and `system-ui` fonts
- Alpha is preserved (`rgba(0,0,0,0)`); ImageMagick flattened it to opaque white
- Colour scheme is **forced to light** (a raster has no OS theme), so output does not depend on the host's desktop theme
- Cost: ~490ms for the first render in a process, ~75-135ms thereafter. The browser is reused and shuts down after 60s idle. One browser per worker process
- `NIMAGE_CHROME_PATH` selects the binary; `NIMAGE_SVG_DEBUG=1` traces DevTools round trips

**Audio:**
- `sample_rate`: 8000/16000/22050/44100/48000 Hz (default 16000 for STT)
- `channels`: 1 (mono) or 2 (stereo), default mono
- `format`: mp3/wav/ogg/m4a/flac/aac/opus
- `sample_rate` and `channels` also accept `"source"` to preserve original values

**Video:**
- `mode`: extract_audio, extract_keyframes, transcode, or cli
- `fps`: Frame rate for keyframe extraction (1-30)
- `max_dimension`: Max frame dimension
- `video_codec` / `audio_codec`: Explicit codec selection (no auto-selection)
- `hwaccel`: Must be explicitly specified; no auto-injection occurs

## Task System

The task system handles asynchronous processing:

- **TaskManager** (`src/tasks/TaskManager.js`) - Singleton coordinator
- **TaskQueue** (`src/tasks/TaskQueue.js`) - FIFO queue with concurrency control
- **Worker** (`src/tasks/Worker.js`) - Processes tasks via PipelineExecutor
- **TaskWorker** (`src/tasks/TaskWorker.js`) - Worker thread bootstrap (thread mode)
- **AssetCache** (`src/cache/AssetCache.js`) - Stores results with TTL
- **JobStore** (`src/jobs/JobStore.js`) - Disk-backed job persistence and upload tracking

A queue slot is released from the worker's `finally` block, *after* `activeTask` is
cleared. Dispatching the next queued task from the completion path looked for an idle
worker while the finishing worker was still marked busy, which failed the queued task and
leaked its slot (issue #1). `TaskQueue` also releases the slot if the processor rejects
before a worker settles the task.

### Worker Execution Modes

Configured via `workers.mode` in `config.json`:

| Mode | Behavior | Use Case |
|------|----------|----------|
| `queue` (default) | Tasks run serialized on the main thread | Memory-constrained, simpler debugging |
| `thread` | Each task spawns a `worker_thread` | True parallelism, lighter than process mode |
| `process` | Each task spawns a `child_process.fork` | Maximum isolation — native crashes don't affect main process or other workers. **Strongly recommended** for audio/video |

**Process mode is strongly recommended** for audio/video. A native module panic in nVideo will kill only the child process, not the main process or other workers.

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
3. `POST /v1/process` returns `jobId` immediately (also `progress_url` and `poll_url`)
4. Client subscribes to progress via SSE (`/v1/jobs/:jobId/progress`) or WebSocket (`/v1/ws`)
5. PipelineExecutor routes to appropriate processor
6. Processor performs transformation with native progress callbacks
7. Result stored in AssetCache; `complete` event includes `assetId`
8. Client downloads from `/v1/assets/:assetId`
9. Optional: `output_path` in process request writes result directly to filesystem

## Error Handling Contract

| HTTP Status | Meaning | Gateway Action |
|-------------|---------|----------------|
| 200 | Success | Swap payload |
| 202 | Accepted (async task queued) | Poll for result |
| 413 | File too large | Return error to client |
| 415 | Unsupported format | Pass-through original |
| 5XX | Processing error | Circuit breaker trips, bypass MPS |

## Recent Fixes & Notes

### Queue dispatch and processor self-check (2026-10-17)
**Issue #1 — stranded queued jobs.** `TaskQueue` freed the slot through `task._onDone`
inside the worker's completion path, before `activeTask` was cleared. The dispatch that
followed therefore looked for an idle worker while the finishing worker was still marked
busy: it threw `No available worker`, failed the queued task without touching its job
record (leaving it `queued` forever) and never removed the task from `running`, so every
occurrence permanently shrank the pool. Cleanup now runs in the worker's `finally` after
`activeTask = null`, and `TaskQueue` releases the slot if a processor rejects before a
worker settles. Regression tests: `tests/task-queue.test.js`
(`a finishing task frees its worker before the next task is dispatched` reproduces the old
failure with one worker).

**Issue #2 — processor self-check.** `nImage.selfCheck()` verifies sharp, ImageMagick and
the SVG browser with a 1×1 PNG fixture; `src/processors/health.js` adds nVideo and caches
the result at startup. `/health` serves the snapshot (status, per-processor state, backend
details, `checkedAt`), `/v1/capabilities` embeds it, and `POST /v1/process` returns **503**
for a processor whose core backend failed instead of queueing a job that cannot succeed.
A failing auxiliary backend (ImageMagick coders, SVG browser) is reported but does not
block the standard raster path.

The 2026-09-27 ImageMagick error stream was re-tested on this host: the shipped
`dist/magick.exe` (ImageMagick 7.1.2-18) decodes PNG/JPEG correctly, with and without a
file extension. `UnableToOpenConfigureFile delegates.xml` is a non-fatal warning; the
fatal `NoDecodeDelegateForThisImageFormat` is what a **non-image** input produces. The
self-check now makes either state visible at startup.

**Issues #3 and #4 — verified fixed by the Chrome renderer.** Rendering the issue's own
minimal pair through the live service produces a transparent canvas, `#888` var()-styled
strokes (the dark media branch does not apply), visible `#1b1b1a` text and no black fill.
A transparent SVG now yields PNG color type 6 and WebP `VP8X`+`ALPH` — alpha is preserved.

### SVG renderer: idle-relaunch hang and stale-document capture (2026-10-17)
The 30s `CDP Runtime.evaluate did not respond` failures were the first render after the
renderer's 60s idle shutdown: the freshly created target can lose its session, and an
in-flight command then never receives a response. `_capture()` now rebuilds the browser
once after any non-session render failure and retries (`_teardown({ force: true })` skips
the graceful close a wedged renderer cannot answer). Timeouts were tightened: the paint
probe is bounded in-page (fonts/rAF backed by timers) at 8s, and the CDP command timeout
is no longer 30s.

Two further defects were found while testing:
- `Page.setDocumentContent` returns before the new document is active, so a fast render
  could capture the **previous** SVG. Each document now carries a per-render marker and
  `_waitForDocument()` confirms activation (Node-driven polling, no page timers) before
  anything is captured.
- The `DevToolsActivePort` readiness poll read the file as soon as it existed; Windows can
  hold it locked mid-write, and the uncaught `EBUSY` crashed the process. Reads are now
  retried until the deadline.

Non-SVG input is rejected in ~300ms with `The rendered document contains no <svg>
element` instead of hanging or silently capturing a blank/stale document. Malformed XML
is rejected as well: the original bytes are re-parsed with `DOMParser` as
`image/svg+xml`, so a document the HTML parser would silently repair now fails with
`Invalid SVG: <parser error>` instead of producing a partial render (the behaviour
reported in issue #5).

### nLogger update and log paths (2026-10-17)
`modules/nLogger` was pinned 7 commits behind upstream. It is now on `main` @ `8decffa`,
which brings the level system, the `unref()`ed flush timer and the silent-log-loss /
JSONL fixes. `logging.level` is therefore enforced again: `src/utils/logger.js` calls
`logger.setLevel(config.logLevel)`, and the value is required and validated at startup.

`logging.logsDir` and `cache.dir` now resolve against the project root instead of
`process.cwd()`. Starting the service from `src/` (the previous deployment) and from the
repository root both write to `<project>/logs` and `<project>/cache`; historical logs from
the old behaviour remain in `src/logs/`.

`npm test` was broken (`tests/index.js` imported a `runner.js` that does not exist). It
now runs `node --test "tests/**/*.test.js"`; `tests/logger.test.js` covers level filtering
and the `logError` stack/metadata behaviour.

### Logging Pass (2026-10-17)
Every `logger.error(message, metaObject)` call was passing metadata into nLogger's
`error` slot, so the error object — message, stack and all context — was discarded. The
logs showed bare `{}` for processor failures and the CDP timeout only appeared one layer
up. All 44 call sites now use `logError(message, error, meta)` from `src/utils/logger.js`,
which also preserves the full stack (nLogger truncates metadata strings to 200 chars).
Added: one HTTP completion log per request with status, duration and `requestId`; request
ids in handler/processor errors; child-process stderr capture and stack propagation from
task workers; fatal `uncaughtException` / `unhandledRejection` logging; WARN for 4xx
(instead of ERROR); logging for previously swallowed read/parse/probe failures; and
`logger.close()` on shutdown so buffered lines are flushed. Details:
`documentation/ARCHITECTURE.md` → Logging.

The pass also fixed `/health`, which had been reporting `degraded` on any deployment
without `tests/assets`: it probed `tests/assets/audio/Vangengel.wav` instead of asking
nVideo whether it was loaded. The probe failure was one of the silently swallowed
catches; the health check now calls `nVideo.getBuildInfo()`.

### SVG Rendering Replaced (issues #3 and #4)
SVG now rasterizes through a persistent headless Chrome/Edge in nImage (`modules/nImage/lib/svg-renderer.js`) instead of ImageMagick. Root cause found: this build of ImageMagick has **no SVG support at all** — no librsvg compiled in, and its `svg` delegate points at an `rsvg-convert` binary that was never shipped, so every SVG silently fell through to a primitive internal renderer (`CSS parsing error`, `Invalid UTF-8 string passed to pango_layout_set_text()`, alpha flattened to opaque white). One defect was behind issues #2, #3 and #4.

Also required: `MagicByteDetector` had no SVG detection, so uploads were rejected with 415 before nImage was ever reached — SVG is XML text with no magic bytes. Both the prolog sniff and the extension map now recognise `svg`/`svgz`.

Rejected alternatives, with evidence: `resvg` has no `var()` support ([linebender/resvg#821](https://github.com/linebender/resvg/issues/821)) and ships no Windows build; sharp/librsvg renders your real diagram correctly but drops `var()` (verified — a `var()` rect came back `rgba(0,0,0,255)` beside a correct literal control). Chrome at ~490ms cold / ~75-135ms warm beat the librsvg route on correctness at close to the same speed.

### Upload Handler `end`/`close` Race
Fixed in `src/api/routes/upload.js`: the `rawRequest` `close` event was destroying the write stream after the `end` event had already fired, causing uploads to hang indefinitely. A `requestEnded` flag now prevents this.

### Progress Completion & assetId
`PipelineExecutor.execute()` sends a `complete` progress event before caching. `Worker.js` now sends a follow-up `complete` event with the actual `assetId` after caching. WS/SSE clients should wait for the event containing `assetId`.

### ESM Worker Loading
Native modules are loaded in worker threads via `createRequire(import.meta.url)` because ESM `worker_threads` does not support direct `require()`.

### Worker Process Mode
Added `process` mode (child_process.fork) for maximum isolation. Native crashes in nVideo only kill the child process, not the main process or other workers. `Worker.js` supports three modes: `process`, `thread`, and `queue`. All three modes are now functional.

### hwaccel Handling
Hardware acceleration is **only applied when explicitly requested** via `options.hwaccel`. No auto-injection occurs in any processor or worker. Users must explicitly specify `hwaccel` in transcode options to enable GPU acceleration.

### Zero-Copy GPU Acceleration Pipeline
The data-flow logic in `src/tasks/TaskWorker.js` propagates `cli_command` and `hwaccel` overrides to the underlying FFmpeg runner. In theory this enables GPU-accelerated pipelines where frames remain in VRAM. **However, HW-accelerated encoding currently crashes** (see `docs/handover_2026-04-22.md`). Software encoding is the reliable path.

### Disk-to-Disk Processing Exceptions
Fixed a crash in `src/tasks/Worker.js` that occurred when jobs utilized hardware acceleration and outputted results directly to disk without passing through software memory. The worker was erroneously querying `result.buffer.length` on disk-only resolutions, throwing a `Cannot read properties of undefined (reading 'length')` error that bubbled up to the UI. The caching flow now properly forks between memory buffers (`result.buffer`) and disk outputs (`result.filePath` / `result.outputPath`).

### Queue Mode Fixed
`Worker.js` now properly handles `queue` mode via `_processInQueue()` which routes through `PipelineExecutor.execute()` on the main thread. Previously, queue mode fell through with `undefined` result.

### Config Validation
`config.js` now validates all required fields at startup: `server.port`, `logging.logsDir`, `media.gpu.platform`, `media.maxFileSizeMb`, `cache.dir`, `cache.ttl`, `cache.maxSize`, `workers.mode`, `workers.maxConcurrentTasks`. Missing fields throw immediately.

### Graceful Shutdown
Added `SIGTERM`/`SIGINT` handlers to `src/index.js`. On shutdown: HTTP server closes, all WebSocket connections are terminated, task manager stops accepting new tasks, cache/job cleanup intervals are stopped, and JobStore persists state to disk.

### Dead Code Cleanup
Removed `MultipartParser._findBoundaryFromEnd()` (never called), duplicate FLAC detection in `MagicByteDetector`, dead `handleVideoProgress()` route in `video.js`, and empty `src/api/middleware/` directory.

### E2E Tests Rewritten
`tests/e2e.test.js` now tests the unified transport flow: `POST /v1/upload` → `POST /v1/process` → `GET /v1/jobs/:id` → `GET /v1/assets/:id`. Tests image, audio, and video processing, path-based processing, job listing, and error cases. Port updated to 3501.

### UUID Generation
Replaced `Math.random()`-based UUID generator with `crypto.randomUUID()` for proper v4 UUIDs.

### Web Frontend Fixes
- SSE EventSource leak fixed in Task Explorer (connection tracked and closed)
- WS reconnect timer cleared on page unload
- Theme preference persisted to localStorage
- Hardcoded dev paths removed from Task Explorer
- System Tests no longer use hardcoded `C:\Media\test.mp4`
- Cache Manager auto-refreshes every 10s
- Dead CSS rule (`.api-preview`) removed

## Web Frontend

The web frontend (`public/`) is a unified NUI-based application that combines service monitoring with task exploration. It serves as both an admin dashboard and a settings explorer for finding optimal API configurations.

### Purpose

- **Dashboard**: Service health, active jobs, cache stats, recent activity
- **Task Explorer**: Interactive tool for testing all processor options and generating API commands (curl, fetch, JSON)
- **Job Monitor**: Real-time job queue with progress tracking, cancel/download actions
- **System Tests**: Verify connectivity, upload, WebSocket, SSE progress streaming
- **Cache Manager**: Browse assets, view metadata, delete individual or clear all

### Architecture

- **NUI Web Components**: Built on `modules/nui_wc2` — native custom elements, no framework
- **Fragment Router**: SPA routing via `nui.setupRouter()`, pages are HTML fragments cached after first load
- **Page Scripts**: Each page uses `<script type="nui/page">` with `init(element, params, nui)` — runs once per page, scoped to page wrapper
- **Shared API Client**: `js/api-client.js` wraps all nMedia endpoints, exposes `window.api` globally
- **WebSocket**: Auto-connects on app load, reconnects on disconnect, broadcasts messages via `window.dispatchEvent(new CustomEvent('ws-message', { detail: msg }))`

### Key Files

| File | Purpose |
|------|---------|
| `public/index.html` | App shell with NUI layout, sidebar navigation, theme toggle |
| `public/js/app.js` | Router setup, navigation data, WS connection management, global action handlers |
| `public/js/api-client.js` | All API calls: upload, process, jobs, assets, capabilities, SSE, WebSocket. Command builders for curl/fetch |
| `public/pages/task-explorer.html` | Main tool: file dropzone, processor selector, dynamic options panel, live API preview, run test |
| `public/pages/dashboard.html` | Service stats, recent jobs table (polls every 5s) |
| `public/pages/job-monitor.html` | Job queue with progress bars, cancel/download (polls every 3s) |
| `public/pages/system-tests.html` | End-to-end verification of all transport mechanisms |
| `public/pages/cache-manager.html` | Asset grid, metadata viewer, bulk delete |

### Task Explorer Design

The core purpose is finding optimal settings for workflows:

1. **Input**: File dropzone (drag/drop or click), or server path input. Dropzone attempts to parse file path for file-to-file workflows
2. **Processor**: Select image/audio/video — options panel updates dynamically
3. **Options**: All processor options exposed as form controls (sliders, selects, checkboxes). Values default to service defaults
4. **API Preview**: Live-updating tabs showing curl, fetch, and JSON payload for current settings
5. **Run**: Uploads file if needed, starts job, subscribes to SSE progress, displays result with download link
6. **Copy**: Copies the active command tab to clipboard

Stateless — no presets or saved configurations. The user copies the command and integrates it into their workflow.

## Job System

The job system manages asynchronous processing and persists state across restarts.

### Components

| Component | File | Purpose |
|-----------|------|---------|
| **JobStore** | `src/jobs/JobStore.js` | Disk-backed persistence for jobs and uploads. JSON file at `cache/jobs/jobs.json` |
| **TaskManager** | `src/tasks/TaskManager.js` | Singleton coordinator, bridges HTTP layer to task queue |
| **TaskQueue** | `src/tasks/TaskQueue.js` | FIFO queue with concurrency control |
| **Worker** | `src/tasks/Worker.js` | Picks up tasks, spawns thread/process or runs on main thread |
| **TaskWorker** | `src/tasks/TaskWorker.js` | Worker thread bootstrap (thread mode only) |
| **Task** | `src/tasks/Task.js` | Task state machine and promise wrapper |

### Job Lifecycle

```
queued → processing → completed/failed/cancelled
```

- Jobs are created with status `queued` and a queue position
- When a worker is available, the job transitions to `processing`
- On completion, the `assetId` is set and `completedAt` timestamped
- On failure, `error` is set
- On cancellation (only while queued), status becomes `cancelled`

### Persistence

JobStore persists to `cache/jobs/jobs.json` on every mutation:
- **Jobs**: All job entries with full state
- **Uploads**: Upload metadata (fileId, tempPath, detected type, size, processed flag)
- **uploadToJob**: Mapping from fileId to jobId
- **nextQueuePosition**: Monotonically increasing counter

### Startup Recovery

On restart:
1. Load persisted jobs and uploads from JSON
2. Jobs in `processing` state are marked `failed` ("Service restarted during processing")
3. Jobs in `queued` remain queued (will be re-processed)

### Cleanup

Runs every 5 minutes:
- **Uploads deleted when**:
  - Unprocessed and expired (> 1h)
  - Processed and job completed/failed/cancelled > 1h ago
  - Processed but job no longer exists
  - Older than 24h (safety net)
- **Jobs deleted when**: completed/failed/cancelled > 1h ago
- **Orphan files**: Files in `cache/uploads/` not tracked in uploads Map are deleted
- **Orphan job files**: Stray files in `cache/jobs/` (only `jobs.json` should remain) are deleted

### ID Chain

```
fileId (upload) → jobId (process) → assetId (result)
```

## Cache System

Two independent cache systems: AssetCache (processed results) and JobStore uploads (raw inputs).

### AssetCache (`src/cache/AssetCache.js`)

Stores processed media results with TTL-based expiration.

| Property | Default | Description |
|----------|---------|-------------|
| `cacheDir` | `cache/assets/` | Storage directory |
| `ttl` | 3600s | Time-to-live for new assets |
| `maxSize` | 10GB | Max total cache size (LRU eviction) |

**TTL Behavior:**
- New assets get `expiresAt = now + ttl`
- On first download (`markRetrieved`), `expiresAt` is set to `now` (expire immediately)
- Cleanup runs every 5 minutes, deleting expired assets

**Persistence:**
- Metadata persisted to `cache/assets/assets.json` on every mutation
- On startup: loads metadata, deletes orphaned files, recalculates `currentSize`
- Files without metadata entries are deleted as orphans

**LRU Eviction:**
- Triggered when `currentSize > maxSize`
- Evicts least-recently-accessed assets until below 80% of max
- Logs each eviction with asset ID, type, size

### JobStore Uploads (`src/jobs/JobStore.js`)

Stores raw uploaded files before processing.

| Property | Default | Description |
|----------|---------|-------------|
| `uploadsDir` | `cache/uploads/` | Storage directory |
| `uploadTTL` | 3600ms | Expiry for unprocessed uploads |

**Upload Lifecycle:**
1. File uploaded via `POST /v1/upload` → written to `cache/uploads/` as temp file
2. Upload registered in JobStore with `processed = false`
3. On process start, upload marked `processed = true`
4. Cleanup deletes upload file and entry when conditions met (see Job System cleanup)

### Storage Layout

```
cache/
├── assets/          # Processed results (AssetCache)
│   ├── assets.json  # Metadata persistence
│   └── {uuid}.{ext} # Asset files
├── uploads/         # Raw uploads (JobStore)
│   └── {uuid}.tmp   # Upload temp files
└── jobs/            # Job persistence
    └── jobs.json    # Job + upload metadata
```

## LLM Integration Notes

- Images are downscaled to reduce token count while preserving visual fidelity
- Audio is resampled to 16kHz mono (optimal for Whisper/STT models)
- Video processing extracts either audio track or keyframes for analysis
- EXIF stripping removes potentially sensitive metadata
- All output formats are widely supported by LLM vision/audio models
