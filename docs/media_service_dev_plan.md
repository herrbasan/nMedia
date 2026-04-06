# Media Service - Development Plan

The **Media Processing Service (MPS)** is a standalone microservice built on **Node.js** as the orchestration platform. Its purpose is to receive multimodal payloads (images, audio, video), process them efficiently using native bindings and CLI tools, and return optimized outputs. GPU acceleration is utilized when available.

---

## 1. Core Objectives

- **Node.js Orchestration:** HTTP server, task management, messaging, and coordination all run on Node.js
- **Hybrid Processing:** Native NAPI for images (nImage), CLI FFmpeg for audio/video (for full feature access)
- **GPU Acceleration:** Utilize NVENC, CUDA, VideoSDK when available for faster encoding/decoding
- **Hybrid Processing:** Synchronous for quick image ops, asynchronous for heavy video/audio tasks, streaming for real-time processing
- **Universal Format Support:** RAW (CR2, NEF, ORF, DNG), HEIC, AVIF, and all formats FFmpeg supports

---

## 2. Technology Stack

### Core Platform
- **Node.js 18+**: HTTP server, orchestration, task queue, messaging
- **Native HTTP**: Built-in `http` module with custom Router (no Express)
- **Native FS**: Built-in `fs` module for file operations
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
| Audio/Video Processing | FFmpeg CLI via fluent-ffmpeg | Full CLI capability access. Future: custom CLI wrapper for direct command control. |

**GPU Acceleration:** FFmpeg supports hardware acceleration via:
- **NVENC**: NVIDIA GPUs (preferred for development)
- **VAAPI**: Intel ARC GPUs (AV1 support)
- **QSV**: Intel Quick Sync Video

Configured via `config.json` (`media.gpu.platform`).

### Why This Architecture?

| Aspect | Approach | Rationale |
|--------|----------|-----------|
| **Images** | nImage NAPI | In-process, fast, handles 150+ formats including RAW/HEIC natively |
| **Audio/Video** | FFmpeg CLI | Full feature access, well-tested, easy to maintain |
| **Future A/V** | FFmpeg NAPI | `ffmpeg-napi-interface` submodule ready for when needed |

---

## 3. Supported API Endpoints

### Synchronous (Image)

#### `POST /v1/optimize/image`
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

#### `POST /v1/optimize/image/crop`
Advanced cropping operations.

* **Accepts:** `multipart/form-data` OR inline `{"base64": "..."}`
* **Parameters:**
  - `crop.type`: region, center, or grid
  - `crop.left/top/right/bottom`: Normalized coordinates (region)
  - `crop.widthPercent/heightPercent`: Percentage (center)
  - `crop.grid.cols/rows/cells`: Grid extraction

### Asynchronous (Audio/Video via Task System)

#### `POST /v1/optimize/audio`
Audio transcoding/resampling (returns 202, use SSE for progress).

* **Parameters:**
  - `sample_rate` (default: 16000)
  - `channels` (default: 1)
  - `format` (default: 'mp3') - mp3, wav, ogg, m4a
  - `response_type` (default: 'base64') - base64 or file

#### `POST /v1/optimize/video`
Video processing (async, returns 202, use SSE for progress).

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
* `GET /v1/tasks/:id/progress` - SSE progress stream

### Asset Cache Endpoints
* `GET /v1/assets` - List assets
* `GET /v1/assets/:id` - Download asset
* `GET /v1/assets/:id/metadata` - Get metadata
* `DELETE /v1/assets/:id` - Delete asset

### Streaming (Real-time) - Future

#### `POST /v1/media/video/stream`
Real-time video processing with streaming response.

#### `POST /v1/media/audio/stream`
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
- Automatic retry with exponential backoff (max 3 attempts)
- Dead letter handling

---

## 5. Messaging Layer

### Transport Adapters

| Transport | Best For | Endpoint |
|-----------|----------|----------|
| SSE | Browser clients | `GET /v1/optimize/progress/:jobId` or `GET /v1/tasks/:id/progress` |
| WebSocket | Low latency, bidirectional | `WS /v1/ws` (future) |
| REST Polling | Firewalls, simple clients | `GET /v1/tasks/:id` |

### Message Types
- `task_created`, `progress`, `completed`, `error`, `cancelled`

---

## 6. Asset Cache

- **Storage:** Local disk (`./cache/assets/`)
- **Default TTL:** 1 hour
- **Max Size:** 10GB (configurable)
- **Cleanup:** Background job every 5 minutes

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

### Phase 3: Audio/Video Processing ⚠️ PARTIAL
1. ~~FFmpeg CLI integration~~ → **DONE** (via fluent-ffmpeg)
2. Audio transcoding/resampling → **DONE** (MP3, WAV, OGG, M4A)
3. Video audio extraction → **DONE**
4. Video keyframe extraction → **DONE**
5. Connect to task system → **TODO** (make video/audio use async task system)
6. Custom FFmpeg CLI wrapper → **TODO** (replace fluent-ffmpeg with direct CLI control)
7. FFmpeg NAPI binding (future) → **PENDING** (use `ffmpeg-napi-interface` submodule)

### Phase 4: Advanced Features 📋 PLANNED
1. Adaptive sync/async logic (auto-detect based on file size)
2. WebSocket messaging adapter
3. REST polling adapter
4. Video streaming endpoint
5. Audio streaming endpoint
6. Task retry logic
7. Cache size management (enforce max cache size)
