# Media Service - Development Plan

The **Media Processing Service (MPS)** is a standalone microservice built on **Node.js** as the orchestration platform. Its purpose is to receive multimodal payloads (images, audio, video), process them efficiently using native bindings and CLI tools, and return optimized outputs. GPU acceleration is utilized when available.

---

## 1. Core Objectives

- **Node.js Orchestration:** HTTP server, task management, messaging, and coordination all run on Node.js
- **Hybrid Processing:** Native NAPI for images (nImage), CLI FFmpeg for audio/video (custom wrapper with GPU support)
- **GPU Acceleration:** Utilize NVENC, VAAPI, QSV when available for faster encoding/decoding
- **Hybrid Processing:** Synchronous for quick image ops, asynchronous for heavy video/audio tasks, streaming for real-time processing
- **Universal Format Support:** RAW (CR2, NEF, ORF, DNG), HEIC, AVIF, and all formats FFmpeg supports

---

## 2. Technology Stack

### Core Platform
- **Node.js 18+**: HTTP server, orchestration, task queue, messaging
- **Native HTTP**: Built-in `http` module with custom Router (no Express)
- **Native FS**: Built-in `fs` module for file operations
- **Child Process**: `spawn` for FFmpeg CLI execution
- **Custom Multipart Parser**: Minimal implementation for file uploads (no Multer)

### Bundled Modules (Submodules in `/modules`)
| Module | Purpose |
|--------|---------|
| nLogger | Structured logging with detailed formatting |
| nImage | Native image processing (RAW, HEIC, 150+ formats via libraw/libheif/ImageMagick) |
| ffmpeg-napi-interface | FFmpeg NAPI bindings for audio/video (future use) |
| nui_wc2 | Web UI for monitoring and testing |

### Media Processing

| Component | Technology | Rationale |
|-----------|------------|-----------|
| Image Processing | nImage (native NAPI) | Native libraw + libheif + Sharp/libvips + ImageMagick fallback. Handles all formats in-process. |
| Audio/Video Processing | FFmpeg CLI (custom wrapper) | Direct command control, hardware acceleration, no external dependencies. File-based I/O for reliability. |

**GPU Acceleration:** FFmpeg supports hardware acceleration via:
- **NVENC**: NVIDIA GPUs (h264_nvenc, hevc_nvenc)
- **VAAPI**: Intel/AMD GPUs (h264_vaapi, hevc_vaapi)
- **QSV**: Intel Quick Sync Video (h264_qsv, hevc_qsv)

Configured via `config.json` (`media.gpu.platform`).

### FFmpeg CLI Wrapper

Custom wrapper located in `src/utils/ffmpeg/`:

```
src/utils/ffmpeg/
├── index.js     # Main API: run(), abort support
├── parser.js    # Progress parsing from stderr
└── codecs.js    # GPU platform codec mappings
```

**Features:**
- File-based I/O (input/output as file paths)
- Automatic GPU codec selection based on platform
- Real-time progress parsing from FFmpeg stderr
- Process cancellation via AbortController
- Automatic cleanup of input temp files

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
3. FFmpeg wrapper processes: temp_input → temp_output
4. Output stored in AssetCache
5. Input temp file deleted immediately
6. SSE: progress updates sent to client
7. SSE: completed event with assetId
8. Client downloads from /v1/assets/:assetId
9. Asset marked as retrieved (TTL = 0)
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

### Phase 3: Audio/Video Processing ✅ COMPLETE
1. ~~FFmpeg CLI wrapper~~ → **DONE** (custom wrapper, replaced fluent-ffmpeg)
2. ~~Audio transcoding/resampling~~ → **DONE** (MP3, WAV, OGG, M4A)
3. ~~Video audio extraction~~ → **DONE**
4. ~~Video keyframe extraction~~ → **DONE**
5. ~~File-based I/O~~ → **DONE** (temp files in cache dir)
6. ~~GPU acceleration~~ → **DONE** (NVENC, VAAPI, QSV with auto-selection)
7. ~~Progress parsing~~ → **DONE** (parse FFmpeg stderr for frame/fps/time/bitrate)
8. ~~Process cancellation~~ → **DONE** (AbortController support)

### Phase 4: Audio/Video Enhancements 📋 CURRENT
1. **Connect to task system** → **TODO** (make video/audio optionally use async task system for large files)
2. **Adaptive sync/async logic** → **TODO** (auto-detect based on file size)
3. **FFmpeg NAPI binding** → **PENDING** (use `ffmpeg-napi-interface` submodule when ready)

### Phase 5: Advanced Features 📋 PLANNED
1. WebSocket messaging adapter
2. REST polling adapter
3. Video streaming endpoint
4. Audio streaming endpoint
5. Task retry logic with exponential backoff
6. Cache size management (enforce max cache size with LRU eviction)
7. Health check endpoint with detailed processor status

---

## 9. FFmpeg CLI Wrapper Details

### Architecture

```javascript
// src/utils/ffmpeg/index.js
export async function run({
  inputPath,      // Input file path
  outputPath,     // Output file path
  args,           // Additional FFmpeg arguments
  onProgress,     // Progress callback (percent, metadata)
  signal,         // AbortController signal
}): Promise<{ exitCode: number, stats: object }>
```

### GPU Codec Selection

```javascript
// src/utils/ffmpeg/codecs.js
const GPU_CODECS = {
  nvenc: {
    videoDecode: ['h264_cuvid', 'hevc_cuvid'],
    videoEncode: { h264: 'h264_nvenc', hevc: 'hevc_nvenc' },
  },
  vaapi: {
    videoDecode: ['h264_vaapi', 'hevc_vaapi'],
    videoEncode: { h264: 'h264_vaapi', hevc: 'hevc_vaapi' },
  },
  qsv: {
    videoDecode: ['h264_qsv', 'hevc_qsv'],
    videoEncode: { h264: 'h264_qsv', hevc: 'hevc_qsv' },
  },
  cpu: {
    videoDecode: [],
    videoEncode: { h264: 'libx264', hevc: 'libx265' },
  },
};
```

### Progress Parsing

FFmpeg outputs progress to stderr in this format:
```
frame=  120 fps= 60 q=28.0 size=     256kB time=00:00:04.00 bitrate= 524.3kbits/s speed=  2x
```

Parsed fields:
- `frame`: Frame number
- `fps`: Encoding FPS
- `q`: Quality factor
- `size`: Output size
- `time`: Timestamp
- `bitrate`: Current bitrate
- `speed`: Encoding speed multiplier

---

## 10. Recent Changes

### 2026-04-06
- Fixed nImage ESM import on Windows using `pathToFileURL`
- All core endpoints functional and tested
- Image processing verified working with PNG/JPEG/RAW/HEIC

### 2026-04-06 - FFmpeg CLI Wrapper
- Replaced fluent-ffmpeg with custom CLI wrapper
- Implemented GPU acceleration (NVENC, VAAPI, QSV)
- File-based I/O for reliability
- Real-time progress parsing from FFmpeg stderr
- Process cancellation support
