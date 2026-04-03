# Media Service - Development Plan

The **Media Processing Service (MPS)** is a standalone microservice built on **Node.js** as the orchestration platform. Its purpose is to receive multimodal payloads (images, audio, video), process them efficiently using native bindings, and return optimized outputs. GPU acceleration is utilized when available.

---

## 1. Core Objectives

- **Node.js Orchestration:** HTTP server, task management, messaging, and coordination all run on Node.js
- **Native NAPI Bindings:** Media processing uses in-process native libraries via Node.js NAPI, not CLI tool wrappers
- **GPU Acceleration:** Utilize NVENC, CUDA, VideoSDK when available for faster encoding/decoding
- **Hybrid Processing:** Synchronous for quick image ops, asynchronous for heavy video/audio tasks, streaming for real-time processing
- **Universal Format Support:** HEIC, AVIF, PSD, TIFF, and all formats FFmpeg supports

---

## 2. Technology Stack

### Core Platform
- **Node.js 18+**: HTTP server, orchestration, task queue, messaging
- **Native HTTP**: Built-in `http` module (no Express)
- **Native FS**: Built-in `fs` module for file operations

### Bundled Modules (Submodules in `/modules`)
| Module | Purpose |
|--------|---------|
| nLogger | Structured logging with detailed formatting |
| ffmpeg-napi-interface | FFmpeg NAPI bindings for audio/video |
| nui_wc2 | Web UI for monitoring and testing |

### Native Media Processing (NAPI)

| Component | Technology | Rationale |
|-----------|------------|-----------|
| Image Processing | libvips via Sharp (initial), custom NAPI later | Fastest image processing, minimal memory |
| Audio/Video Processing | FFmpeg libs via custom NAPI binding | Pattern inspired by `ffmpeg-napi-interface` (SoundApp/libs) |

**GPU Acceleration:** FFmpeg supports hardware acceleration via:
- **NVENC**: NVIDIA GPUs (preferred for development)
- **VAAPI**: Intel ARC GPUs (AV1 support)
- **QSV**: Intel Quick Sync Video

Configured via `config.json` (`media.gpu.platform`). FFmpeg command patterns adjust based on selected platform.

### Why NAPI Over CLI?

CLI tool wrappers (ImageMagick CLI, FFmpeg CLI, fluent-ffmpeg) have inherent limitations:

| CLI Approach | NAPI Approach |
|--------------|---------------|
| Process spawn overhead (10-50ms) | Immediate call overhead (<1ms) |
| Limited streaming (pipes) | Full frame-by-frame streaming |
| Text parsing for progress | Direct callback access |
| Memory copying via pipes | Direct buffer access |
| External binary dependency | Bundled static libs |

---

## 3. Supported API Endpoints

### Synchronous (Image)

#### `POST /v1/media/image/process`
Quick image operations (<500ms response).

* **Accepts:** `multipart/form-data` OR inline `{"base64": "..."}`
* **Parameters:**
  - `max_dimension` (default: 1024)
  - `quality` (default: 85)
  - `format` (default: 'jpeg') - jpeg, png, webp, avif, gif, heic
  - `strip_exif` (default: true)
* **Returns:**
  ```json
  {
    "original_size_bytes": 5242880,
    "output_size_bytes": 102400,
    "format": "image/jpeg",
    "base64": "..."
  }
  ```

#### `POST /v1/media/image/crop`
Advanced cropping operations.

* **Accepts:** `multipart/form-data` OR inline `{"base64": "..."}`
* **Parameters:**
  - `crop.type`: region, center, or grid
  - `crop.left/top/right/bottom`: Normalized coordinates (region)
  - `crop.widthPercent/heightPercent`: Percentage (center)
  - `crop.grid.cols/rows/cells`: Grid extraction

### Asynchronous (Audio/Video)

#### `POST /v1/tasks`
Create an async processing task.

* **Accepts:** `multipart/form-data` with file or base64 input
* **Parameters:**
  - `type`: image, audio, or video
  - `operation`: transcode, resize, crop, extract_audio, extract_keyframes, etc.
  - `options`: Operation-specific parameters
  - `ttl`: Cache TTL in seconds (default: 3600)

#### `POST /v1/media/audio`
Audio transcoding/resampling.

* **Parameters:**
  - `sample_rate` (default: 16000)
  - `channels` (default: 1)
  - `format` (default: 'mp3')

#### `POST /v1/media/video`
Video processing (async).

* **Parameters:**
  - `mode`: extract_audio, extract_keyframes, transcode
  - `fps`: Frames per second for keyframe extraction
  - `format`: Output format

### Streaming (Real-time)

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
| SSE | Browser clients | `GET /v1/events` |
| WebSocket | Low latency, bidirectional | `WS /v1/ws` |
| REST Polling | Firewalls, simple clients | `GET /v1/tasks/:id/status` |

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
| 400 | Bad request | Return error |
| 404 | Not found | Return error |
| 413 | File too large | Return error to client |
| 415 | Unsupported format | Pass-through original |
| 5XX | Processing error | Circuit breaker trips, bypass MPS |

---

## 8. Dockerization

```dockerfile
FROM node:20-alpine

# Install build tools for NAPI compilation
RUN apk add --no-cache python3 make g++

# Copy package files
COPY package*.json ./
RUN npm ci --ignore-scripts

# Copy FFmpeg staticlibs and libvips
COPY deps/ /deps/

# Build native addons
RUN npm run build:native

# Copy application code
COPY src/ ./src/
COPY cache/ ./cache/

ENV PORT=3500
ENV MAX_CONCURRENT_TASKS=4

EXPOSE 3500
CMD ["npm", "start"]
```

### Key Considerations
- FFmpeg and libvips bundled as static libraries, not CLI binaries
- Custom NAPI bindings link against these static libs
- No ImageMagick CLI dependency - libvips handles all formats natively

---

## 9. Development Phases

### Phase 1: Core Foundation
1. ~~Node.js HTTP server with Express~~ → **DONE** (native `http` module + custom multipart parser)
2. ~~Task system (create, status, queue, workers)~~ → **DONE** (Task, TaskStore, TaskQueue, Worker, TaskManager)
3. ~~SSE messaging adapter~~ → **DONE** (ProgressReporter decoupled via Sender interface)
4. ~~Asset cache with TTL~~ → **DONE** (AssetCache class, disk storage, TTL cleanup)

### Phase 2: Image Processing
1. ~~Sharp for standard image operations~~ → **DONE** (resize, crop, convert, strip_exif)
2. ~~HEIC format support via FFmpeg pre-decode~~ → **DONE** (HeifDecoder utility)
3. ~~RAW format support (CR2, ORF) via ImageMagick~~ → **DONE** (ImageMagick external decoder)
4. Native HEIF/AVIF decoder (future - libvips NAPI binding)
5. Native RAW decoder (future - dcraw or libraw NAPI binding)

### Phase 3: Audio/Video NAPI
1. Custom FFmpeg NAPI binding (avcodec, avformat, swresample)
2. Audio decode/encode/transcode
3. Video decode/encode/transcode
4. Frame-level streaming API

### Phase 4: Advanced Features
1. Video streaming endpoint
2. Audio streaming endpoint
3. WebSocket messaging adapter
4. REST polling adapter
5. Task retry logic
6. Cache size management
