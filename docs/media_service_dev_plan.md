# Media Service - Development Plan

The **Media Processing Service (MPS)** is a standalone microservice built on **Node.js** as the orchestration platform. Its purpose is to receive multimodal payloads (images, audio, video), process them efficiently using native N-API bindings (nImage for images, nVideo for audio/video), and return optimized outputs. GPU acceleration is utilized when available.

---

## 1. Core Objectives

- **Node.js Orchestration:** HTTP server, task management, messaging, and coordination all run on Node.js
- **Unified Native Processing:** NAPI for all media - nImage for images, nVideo for audio/video
- **GPU Acceleration:** Utilize NVENC, VAAPI, QSV when available for faster encoding/decoding
- **Processing Modes:** Synchronous for quick image ops, asynchronous for heavy video/audio tasks
- **Worker Modes:** Queue mode (serialized, main thread) or Thread mode (parallel, worker_threads)
- **Universal Format Support:** RAW (CR2, NEF, ORF, DNG), HEIC, AVIF, and all formats FFmpeg supports

---

## 2. Technology Stack

### Core Platform
- **Node.js 18+**: HTTP server, orchestration, task queue, messaging
- **Native HTTP**: Built-in `http` module with custom Router (no Express)
- **Native FS**: Built-in `fs` module for file operations
- **Worker Threads**: Built-in `worker_threads` for parallel processing (thread mode)
- **Custom Multipart Parser**: Minimal implementation for file uploads (no Multer)

### Bundled Modules (Submodules in `/modules`)
| Module | Purpose |
|--------|---------|
| nLogger | Structured logging with detailed formatting |
| nImage | Native image processing (RAW, HEIC, 150+ formats via libraw/libheif/ImageMagick) |
| nVideo | Native audio/video processing (direct FFmpeg library integration via N-API) |
| nui_wc2 | Web UI for monitoring and testing |

### Media Processing

| Component | Technology | Rationale |
|-----------|------------|-----------|
| Image Processing | nImage (native NAPI) | Native libraw + libheif + Sharp/libvips + ImageMagick fallback. Handles all formats in-process. |
| Audio/Video Processing | nVideo (native NAPI) | Direct FFmpeg library integration. Zero process spawning, zero-copy decode, native progress. File-to-file I/O for reliability. |

**GPU Acceleration:** nVideo supports hardware acceleration via native HW device context:
- **NVENC**: NVIDIA GPUs (h264_nvenc, hevc_nvenc, h264_cuvid, hevc_cuvid)
- **VAAPI**: Intel/AMD GPUs (h264_vaapi, hevc_vaapi)
- **QSV**: Intel Quick Sync Video (h264_qsv, hevc_qsv)
- **D3D11VA**: Windows DirectX (decode only)

Configured via `config.json` (`media.gpu.platform`).

### nVideo Native Module

nVideo is located at `/modules/nVideo`. It links directly against FFmpeg's C libraries (no CLI spawning).

```
modules/nVideo/
├── src/
│   ├── processor.cpp   # FFmpeg C API implementation (~3000 lines)
│   ├── processor.h     # Data structures and class declarations
│   └── binding.cpp     # N-API bindings layer
├── lib/
│   └── index.js        # JavaScript API wrapper with SHA256 caching
└── binding.gyp         # node-gyp build configuration
```

**Key APIs used by MediaService:**
- `probe(path)` - Metadata, streams, codec info
- `transcode(input, output, opts)` - Full re-encode with progress callbacks
- `extractAudio(input, output, opts)` - Audio extraction from video
- `thumbnail(path, opts)` - Seek + decode single frame
- `remux(input, output, opts)` - Stream copy without re-encode
- `concat(files, output, opts)` - Multi-file join

**Features:**
- File-to-file transcoding runs entirely in C++ (no JS involvement)
- Audio filter graphs (`abuffer → aformat → asetnsamples → abuffersink`)
- Video filter graphs via libavfilter
- Native progress callbacks (percent, speed, bitrate, ETA)
- SHA256-based caching with transmit-once TTL
- Hardware acceleration (CUDA, QSV, VAAPI, D3D11VA)

### Worker Execution Modes

Processing runs in configurable modes via `workers.mode`:

**Queue Mode** (`"queue"` - default):
- Tasks processed via TaskQueue → Worker → PipelineExecutor on main thread
- Serialized execution, lower memory footprint

**Thread Mode** (`"thread"`):
- Each task spawns a Node.js `worker_thread`
- nVideo runs in worker, main event loop stays free
- True parallelism bounded by `maxConcurrentTasks`
- Worker bootstrap: `src/tasks/TaskWorker.js`

---

## 3. Supported API Endpoints

### Synchronous (Image)

#### `POST /v1/process/image`
Quick image operations (<500ms response). Supports all formats via nImage (JPEG, PNG, WebP, AVIF, GIF, RAW, HEIC, PDF, SVG, etc.).

* **Accepts:** `multipart/form-data` OR inline `{"base64": "..."}`
* **Parameters:**
  - `max_dimension` (default: 1024)
  - `quality` (default: 85)
  - `format` (default: 'jpeg') - jpeg, png, webp, avif, gif
  - `strip_exif` (default: true)
  - `response_type` (default: 'base64') - base64 or file
* **Returns:**
  ```json
  {
    "original_size_bytes": 5242880,
    "optimized_size_bytes": 102400,
    "width": 1024,
    "height": 768,
    "format": "jpeg",
    "base64": "..."
  }
  ```

#### `POST /v1/process/image/crop`
Advanced cropping operations.

* **Accepts:** `multipart/form-data` OR inline `{"base64": "..."}`
* **Parameters:**
  - `crop.type`: region, center, or grid
  - `crop.left/top/right/bottom`: Normalized coordinates (region)
  - `crop.widthPercent/heightPercent`: Percentage (center)
  - `crop.grid.cols/rows/cells`: Grid extraction

### Asynchronous (Audio/Video via Task System)

#### `POST /v1/process/audio`
Audio transcoding/resampling (synchronous with SSE progress, returns 200).

* **Parameters:**
  - `sample_rate` (default: 16000)
  - `channels` (default: 1)
  - `format` (default: 'mp3') - mp3, wav, ogg, m4a
  - `response_type` (default: 'base64') - base64 or file

#### `POST /v1/process/video`
Video processing (synchronous with SSE progress, returns 200).

* **Parameters:**
  - `mode`: extract_audio, extract_keyframes
  - `fps`: Frames per second for keyframe extraction
  - `max_dimension`: Max dimension for extracted frames
  - `response_type` (default: 'base64') - base64 or file

#### Task System Endpoints
* `POST /v1/tasks` - Create async task
* `GET /v1/tasks` - List tasks
* `GET /v1/tasks/:id` - Get task status
* `GET /v1/tasks/:id/result` - Download result
* `DELETE /v1/tasks/:id` - Cancel pending task
* `GET /v1/tasks/stats` - Queue statistics

### Asset Cache Endpoints
* `GET /v1/assets` - List assets
* `GET /v1/assets/:id` - Download asset
* `GET /v1/assets/:id/metadata` - Get metadata
* `DELETE /v1/assets/:id` - Delete asset
* `DELETE /v1/assets` - Clear all assets

### Streaming (Real-time) - Future

#### `POST /v1/process/video/stream`
Real-time video processing with streaming response.

#### `POST /v1/process/audio/stream`
Real-time audio processing with streaming response.

---

## 4. Task System

### Task Lifecycle

```
[Create] → [Queued] → [Processing] → [Completed]
               ↓            ↓
           [Cancelled]   [Failed]
```

### Task Queue
- In-memory queue with priority support
- Configurable max concurrent workers
- Background cleanup of completed/failed tasks (1 hour TTL)

### Audio/Video Processing Flow

```
1. Client uploads file to /v1/process/video
2. Server writes input to temp file in cache dir
3. Task queued → Worker picks up (queue mode) or worker_thread spawned (thread mode)
4. nVideo processes: temp_input → temp_output (all in C++ memory)
5. Output stored in AssetCache
6. Input temp file deleted immediately
7. SSE: progress updates sent to client (via native callback)
8. SSE: completed event with assetId
9. Client downloads from /v1/assets/:assetId
10. Asset marked as retrieved (TTL = 0)
```

---

## 5. Messaging Layer

### Transport Adapters

| Transport | Best For | Endpoint |
|-----------|----------|----------|
| SSE | Browser clients | `GET /v1/process/progress/:jobId` or `GET /v1/tasks/:id/progress` |
| WebSocket | Low latency, bidirectional | `WS /v1/ws` (future) |
| REST Polling | Firewalls, simple clients | `GET /v1/tasks/:id` |

### Message Types
- `start`, `progress`, `complete`, `error`, `cancelled`

---

## 6. Asset Cache

- **Storage:** Local disk (`./cache/assets/`)
- **Default TTL:** 1 hour
- **Retrieved TTL:** 0 (immediate cleanup on next cycle)
- **Max Size:** 10GB (configurable)
- **Cleanup:** Background job every 5 minutes

### TTL Management

| Scenario | TTL Strategy |
|----------|-------------|
| Asset created | Default TTL (1 hour) |
| Asset retrieved | TTL set to 0 (cleanup next cycle) |
| Explicit delete | Immediate removal |

### Endpoints
- `GET /v1/assets/:id` - Download
- `GET /v1/assets/:id/metadata` - Metadata
- `DELETE /v1/assets/:id` - Delete

---

## 7. Error Handling & Gateway Contract

| HTTP Status | Meaning | Gateway Action |
|-------------|---------|----------------|
| 200 | Success | Swap payload |
| 202 | Accepted (async task queued) | Poll for result |
| 400 | Bad request | Return error |
| 404 | Not found | Return error |
| 413 | File too large | Return error to client |
| 415 | Unsupported format | Pass-through original |
| 5XX | Processing error | Circuit breaker trips, bypass MPS |

---

## 8. Development Phases

### Phase 1: Core Foundation ✅ COMPLETE
1. ~~Node.js HTTP server~~ → **DONE** (native `http` module + custom Router)
2. ~~Custom multipart parser~~ → **DONE** (no Multer)
3. ~~Task system~~ → **DONE** (Task, TaskStore, TaskQueue, Worker, TaskManager)
4. ~~SSE messaging~~ → **DONE** (ProgressReporter decoupled via Sender interface)
5. ~~Asset cache~~ → **DONE** (AssetCache class, disk storage, TTL cleanup)

### Phase 2: Image Processing ✅ COMPLETE
1. ~~nImage integration~~ → **DONE** (native NAPI with libraw/libheif/ImageMagick)
2. ~~RAW format support~~ → **DONE** (CR2, NEF, ARW, ORF, DNG, etc. via libraw)
3. ~~HEIC/HEIF support~~ → **DONE** (via libheif, no FFmpeg fallback needed)
4. ~~150+ format support~~ → **DONE** (ImageMagick fallback for PDF, SVG, EXR, HDR, etc.)
5. ~~ESM Windows import fix~~ → **DONE** (using `pathToFileURL` for nImage import)

### Phase 3: Audio/Video Processing (FFmpeg CLI) ✅ COMPLETE → SUPERSEDED
1. ~~FFmpeg CLI wrapper~~ → **DONE** (custom wrapper, replaced fluent-ffmpeg) - *superseded by nVideo*
2. ~~Audio transcoding/resampling~~ → **DONE** (MP3, WAV, OGG, M4A) - *migrated to nVideo*
3. ~~Video audio extraction~~ → **DONE** - *migrated to nVideo*
4. ~~Video keyframe extraction~~ → **DONE** - *migrated to nVideo*
5. ~~File-based I/O~~ → **DONE** (temp files in cache dir) - *retained with nVideo*
6. ~~GPU acceleration~~ → **DONE** (NVENC, VAAPI, QSV with auto-selection) - *migrated to nVideo*
7. ~~Progress parsing~~ → **DONE** (parse FFmpeg stderr) - *replaced by nVideo native callbacks*
8. ~~Process cancellation~~ → **DONE** (AbortController) - *to be reimplemented in nVideo*

### Phase 4: nVideo Integration 🔄 CURRENT
1. **Add nVideo submodule** → `modules/nVideo` (git submodule from herrbasan/nVideo)
2. **Build nVideo** → `npm run setup && npm run build` (download FFmpeg libs, compile)
3. **Rewrite AudioProcessor** → Use nVideo `transcode()` / `extractAudio()` / `probe()`
4. **Rewrite VideoProcessor** → Use nVideo `extractAudio()` / `thumbnail()` / `transcode()`
5. **Remove FFmpeg CLI wrapper** → Delete `src/utils/ffmpeg/`
6. **Remove FFmpeg binary** → Delete `bin/ffmpeg.exe`
7. **Add worker mode config** → `workers.mode` (queue/thread)
8. **Implement TaskWorker** → `src/tasks/TaskWorker.js` for thread mode
9. **Update config** → Remove `media.ffmpegPath`, add `workers.mode`

### Phase 5: Advanced Features 📋 PLANNED
1. WebSocket messaging adapter
2. REST polling adapter
3. Task retry logic with exponential backoff
4. Cache size management (enforce max cache size with LRU eviction)
5. Health check endpoint with detailed processor status

---

## 9. nVideo Integration Details

### Architecture

```javascript
// modules/nVideo/lib/index.js
const nVideo = require('nvideo');

// Probe metadata
const info = nVideo.probe('input.mp4');

// Transcode with progress
nVideo.transcode('input.mkv', 'output.mp4', {
  video: { codec: 'libx264', width: 1280, height: 720, crf: 23 },
  audio: { codec: 'aac', bitrate: 128000, sampleRate: 16000, channels: 1 },
  onProgress: (p) => console.log(`${p.percent.toFixed(1)}% at ${p.speed.toFixed(1)}x`),
  onComplete: (r) => console.log(`Done in ${(r.timeMs / 1000).toFixed(1)}s`)
});

// Extract audio from video
nVideo.extractAudio('input.mp4', 'output.mp3', {
  codec: 'mp3',
  bitrate: 128000,
  onProgress: (p) => { /* ... */ }
});
```

### GPU Codec Selection

nVideo uses native HW device context for GPU acceleration:
- **CUDA** (NVENC): `av_hwdevice_ctx_create(AV_HWDEVICE_TYPE_CUDA)`
- **QSV**: `av_hwdevice_ctx_create(AV_HWDEVICE_TYPE_QSV)`
- **VAAPI**: `av_hwdevice_ctx_create(AV_HWDEVICE_TYPE_VAAPI)`
- **D3D11VA**: `av_hwdevice_ctx_create(AV_HWDEVICE_TYPE_D3D11VA)`

Configured via `config.media.gpu.platform` → mapped to `AVHWDeviceType`.

### Progress Callbacks

nVideo provides native progress callbacks (no stderr parsing):
- `percent`: 0-100 completion
- `speed`: Encoding speed multiplier
- `bitrate`: Current bitrate
- `timestamp`: Current stream position
- `eta`: Estimated time remaining

---

## 10. Recent Changes

### 2026-04-14 - nVideo Integration Pivot
- Replaced FFmpeg CLI wrapper with nVideo native N-API module
- Unified native processing: nImage (images) + nVideo (audio/video)
- Added configurable worker execution mode (queue/thread)
- Removed FFmpeg binary dependency

### 2026-04-06
- Fixed nImage ESM import on Windows using `pathToFileURL`
- All core endpoints functional and tested
- Image processing verified working with PNG/JPEG/RAW/HEIC
