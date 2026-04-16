# Media Service - Specification

## 1. Overview

Media Service is a comprehensive media processing microservice built on **Node.js** as the orchestration and HTTP platform. It provides both synchronous operations for low-latency needs and asynchronous operations for heavy media tasks. GPU acceleration (NVENC, VAAPI, QSV) is utilized when available.

### Platform Decisions

- **Orchestration**: Node.js (HTTP server, task management, messaging)
- **Image Processing**: Native NAPI bindings (nImage with libraw/libheif/ImageMagick)
- **Audio/Video Processing**: Native NAPI bindings (nVideo with direct FFmpeg library integration)
- **Unified Native Architecture**: NAPI for all media processing - zero process spawning, zero-copy decode, real-time progress

### Use Cases

| Category | Operations | Execution Mode |
|----------|------------|---------------|
| Image | Convert, crop, resize, format | Sync |
| Video | Transcode, crop, resize, keyframes, thumbnails | Async |
| Audio | Transcode, resample, trim | Async |
| Video Streaming | Real-time transcode, crop, resize, stream | Streaming |
| Audio Streaming | Real-time resample, transcode, stream | Streaming |

---

## 2. Architecture

### 2.1 Processing Modes

| Mode | Use Case | Latency | Bounded By |
|------|----------|---------|------------|
| **Sync** | Quick image ops (resize, crop, convert) | <500ms | Request timeout |
| **Async** | Heavy tasks (video transcode, audio transcode) | Seconds-minutes | Task queue + workers |
| **Streaming** | Real-time media processing | Real-time | Connection lifecycle |

### 2.2 Component Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        Media Service                             │
│                        (Node.js)                                │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │ HTTP Server │  │ Task Queue  │  │   Messaging Layer       │  │
│  │  (native)   │  │ (In-Memory) │  │ (SSE/WebSocket/REST)    │  │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘  │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │                    Native Processors                        │  │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │  │
│  │  │ Image       │  │ Audio       │  │ Video               │  │  │
│  │  │ (nImage     │  │ (nVideo     │  │ (nVideo             │  │  │
│  │  │  NAPI)      │  │  NAPI)      │  │  NAPI)              │  │  │
│  │  └─────────────┘  └─────────────┘  └─────────────────────┘  │  │
│  └─────────────────────────────────────────────────────────────┘  │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │                    Asset Cache                             │  │
│  │               (Disk + TTL management)                      │  │
│  └─────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### 2.3 Native Binding Strategy

#### Image Processing (nImage - Native NAPI)
- **Why**: Native performance with comprehensive format support via NAPI
- **Architecture**:
  - **LibRaw**: RAW formats (CR2, NEF, ARW, ORF, DNG, etc.)
  - **LibHeif**: HEIC/HEIF/AVIF formats  
  - **Sharp/libvips**: Standard formats (JPEG, PNG, WebP, GIF, TIFF, AVIF) + transforms
  - **ImageMagick**: 150+ additional formats (PDF, SVG, EXR, HDR, etc.)
- **Capabilities**: Resize, crop, format conversion, EXIF stripping, region extraction

#### Audio/Video Processing (nVideo - Native NAPI)
- **Why**: Direct FFmpeg library integration - zero process spawning, zero-copy decode, native progress callbacks
- **Architecture**:
  - Direct FFmpeg C API (`avformat`, `avcodec`, `avfilter`, `swscale`, `swresample`)
  - File-to-file transcoding runs entirely in C++ (no JS involvement during processing)
  - Automatic GPU codec selection based on `config.media.gpu.platform`
  - Support for NVENC (NVIDIA), QSV (Intel), VAAPI (Intel/AMD), D3D11VA (Windows)
  - Audio filter graphs (`abuffer → aformat → asetnsamples → abuffersink`) for reliable transcoding
  - Video filter graphs via libavfilter
- **Capabilities**:
  - `probe()`: Metadata, streams, codec info (no ffprobe spawn)
  - `transcode()`: Full re-encode with video/audio filter graphs, HW acceleration, progress callbacks
  - `extractAudio()`: Decode audio from video, re-encode to target format
  - `thumbnail()`: Seek to timestamp, decode single frame
  - `remux()`: Stream copy without re-encode
  - `concat()`: Multi-file join with timestamp management
  - `getWaveform()`: Audio peak amplitude generation
  - Stateful decode: `openInput()`, `readAudio()`, `readVideoFrame()`, `seek()`, `close()`

---

## 3. nVideo Native Module

### 3.1 Architecture

nVideo is a native N-API module located at `/modules/nVideo`. It links directly against FFmpeg's C libraries (no CLI spawning).

```
modules/nVideo/
├── src/
│   ├── processor.cpp   # FFmpeg C API implementation (~3000 lines)
│   ├── processor.h     # Data structures and class declarations
│   └── binding.cpp     # N-API bindings layer
├── lib/
│   └── index.js        # JavaScript API wrapper with caching
└── binding.gyp         # node-gyp build configuration
```

### 3.2 Key Features

| Feature | Implementation |
|---------|----------------|
| **I/O Mode** | File-to-file (temp files in cache dir) |
| **Input Handling** | Write buffer → temp file → nVideo processes → read output file |
| **GPU Acceleration** | Native HW device context (CUDA, QSV, VAAPI, D3D11VA) |
| **Progress** | Native callback (percent, speed, bitrate, ETA, frame counts) |
| **Cancellation** | Not yet implemented (planned) |
| **Cleanup** | Input temp file deleted immediately; output stored in AssetCache |
| **Caching** | SHA256-based cache with transmit-once TTL (built into nVideo) |

### 3.3 GPU Platform Support

| Platform | Video Decode | Video Encode | Audio |
|----------|--------------|--------------|-------|
| `nvenc` | h264_cuvid, hevc_cuvid | h264_nvenc, hevc_nvenc | CPU |
| `vaapi` | h264_vaapi, hevc_vaapi | h264_vaapi, hevc_vaapi | CPU |
| `qsv` | h264_qsv, hevc_qsv | h264_qsv, hevc_qsv | CPU |
| `cpu` | software | libx264, libx265 | CPU |

### 3.4 Progress Format

nVideo provides native progress callbacks with:
- `percent`: 0-100 completion
- `speed`: Encoding speed multiplier
- `bitrate`: Current bitrate
- `timestamp`: Current stream position
- `eta`: Estimated time remaining

Progress callback: `(percent, { speed, bitrate, timestamp, eta })`

---

## 4. Task System

### 4.1 Task Model

```javascript
{
  id: string,                    // UUID v4
  type: 'image' | 'audio' | 'video',
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled',
  input: Buffer | string,        // Input data (buffer or base64)
  options: object,               // Operation-specific parameters
  progressReporter: Sender,      // SSE connection for progress events
  percent: number,                // 0-100 progress
  result: {
    buffer: Buffer,               // Output buffer
    metadata: object,            // Processing metadata
  },
  assetId: string | null,        // Cached result asset ID
  createdAt: number,             // Unix timestamp
  startedAt: number,             // Unix timestamp
  completedAt: number,           // Unix timestamp
  error: string,                 // Error message if failed
}
```

### 4.2 Task Lifecycle

```
[Create] → [Pending] → [Running] → [Completed]
                           ↓
                       [Failed]
                           ↓
                      [Cancelled]
```

### 4.3 Task System Implementation

**Components:**
- `Task` - Task state and lifecycle management
- `TaskStore` - In-memory task storage with filtering and cleanup
- `TaskQueue` - FIFO queue with concurrency control (maxConcurrentTasks)
- `Worker` - Processes tasks via PipelineExecutor
- `TaskManager` - Singleton coordinator, wires queue→workers

**API Endpoints:**
| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/v1/tasks` | Create and submit task (returns 202) |
| `GET` | `/v1/tasks` | List tasks (filter by status, type) |
| `GET` | `/v1/tasks/stats` | Queue/worker statistics |
| `GET` | `/v1/tasks/:taskId` | Get task status |
| `GET` | `/v1/tasks/:taskId/result` | Download result buffer |
| `DELETE` | `/v1/tasks/:taskId` | Cancel pending task |

### 4.4 Audio/Video Task Flow

```
Client → POST /v1/process/video (file uploaded)
            ↓
        Route Handler writes file to temp input file
            ↓
        Task created with input file path
            ↓
        Task queued → Worker picks up
            ↓
        nVideo processes (file → file, all in C++ memory)
            ↓
        Output file stored in AssetCache
            ↓
        Input temp file deleted immediately
            ↓
        SSE: completed event with assetId
            ↓
 Client → GET /v1/assets/:assetId (download result)
            ↓
        Asset marked as retrieved (TTL reduced to 0)
```

### 4.5 Worker Execution Modes

Processing can run in two modes, configured via `workers.mode`:

**Queue Mode** (`"queue"` - default):
- Tasks processed via TaskQueue → Worker → PipelineExecutor on main thread
- Serialized execution, lower memory footprint
- Event loop blocked during processing (acceptable for sync endpoints)

**Thread Mode** (`"thread"`):
- Each task spawns a Node.js `worker_thread`
- nVideo runs synchronously in worker, main event loop stays free
- True parallelism bounded by `maxConcurrentTasks`
- Requires worker bootstrap (`src/tasks/TaskWorker.js`) with message protocol:
  - Input: `{ type: 'process', mediaType, inputPath, outputPath, options }`
  - Output: `{ type: 'progress', percent, metadata }` | `{ type: 'complete', result }` | `{ type: 'error', message }`

---

## 5. Asset Cache

### 5.1 Asset Model

```javascript
{
  id: string,                    // UUID v4
  type: 'image' | 'audio' | 'video',
  mimeType: string,
  size: number,                  // Bytes
  storagePath: string,          // Relative to cache root
  createdAt: timestamp,
  expiresAt: timestamp,         // TTL countdown
  retrievedAt: timestamp|null,  // When downloaded by client
  metadata: {
    width?: number,
    height?: number,
    duration?: number,
    codec?: string,
  },
}
```

### 5.2 Cache Management

- **Storage**: Local disk (`./cache/assets/`)
- **Default TTL**: 1 hour (configurable)
- **Retrieved TTL**: 0 (immediate cleanup on next cycle)
- **Max Cache Size**: 10GB (configurable)
- **Cleanup**: Background job every 5 minutes
- **Naming**: `{asset_id}.{extension}`

### 5.3 TTL Strategy

| Scenario | TTL Action |
|----------|-----------|
| Task created | Default TTL (1 hour) |
| Asset retrieved | TTL set to 0 (cleanup next cycle) |
| Explicit delete | Immediate removal |

### 5.4 Cache Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/v1/assets/:id` | Download asset file |
| `GET` | `/v1/assets/:id/metadata` | Get asset metadata |
| `DELETE` | `/v1/assets/:id` | Delete specific asset |
| `DELETE` | `/v1/assets` | Clear all assets (admin) |

---

## 6. API Specification

### 6.1 Task Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/v1/tasks` | Create new task |
| `GET` | `/v1/tasks/:id` | Get task details |
| `GET` | `/v1/tasks/:id/status` | Get task status (polling) |
| `GET` | `/v1/tasks` | List tasks (with filters) |
| `DELETE` | `/v1/tasks/:id` | Cancel task |

### 6.2 Sync Endpoints (Image)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/v1/process/image` | Process image synchronously |
| `POST` | `/v1/process/image/crop` | Crop image synchronously |

### 6.3 Async Endpoints (Audio/Video)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/v1/process/audio` | Process audio asynchronously |
| `POST` | `/v1/process/video` | Process video asynchronously |
| `GET` | `/v1/process/progress/:jobId` | SSE progress stream |

### 6.4 Asset Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/v1/assets/:id` | Download asset |
| `GET` | `/v1/assets/:id/metadata` | Get metadata |
| `DELETE` | `/v1/assets/:id` | Delete asset |

### 6.5 System Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Health check |
| `GET` | `/v1/events` | SSE events stream |
| `WS` | `/v1/ws` | WebSocket connection (future) |

---

## 7. Detailed Endpoint Specifications

### 7.1 POST /v1/process/audio

Asynchronous audio processing.

**Request:**
- `multipart/form-data` with `file` field
- OR JSON with `base64` field

**Parameters:**
| Name | Type | Default | Description |
|------|------|---------|-------------|
| `sample_rate` | int | 16000 | Output sample rate (8000/16000/22050/44100/48000) |
| `channels` | int | 1 | Output channels (1=mono, 2=stereo) |
| `format` | string | mp3 | Output format: mp3, wav, ogg, m4a |
| `response_type` | string | base64 | base64 or file |

**Response (202 Accepted when async):**
```json
{
  "taskId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "queued",
  "progressUrl": "/v1/process/progress/550e8400-..."
}
```

**Response (200 OK when sync):**
```json
{
  "original_size_bytes": 5242880,
  "optimized_size_bytes": 102400,
  "sampleRate": 16000,
  "channels": 1,
  "format": "mp3",
  "base64": "data:audio/mpeg;base64,..."
}
```

### 7.2 POST /v1/process/video

Asynchronous video processing.

**Request:**
- `multipart/form-data` with `file` field
- OR JSON with `base64` field

**Parameters:**
| Name | Type | Default | Description |
|------|------|---------|-------------|
| `mode` | string | extract_audio | extract_audio or extract_keyframes |
| `fps` | int | 1 | Frames per second for keyframes (1-30) |
| `max_dimension` | int | 1024 | Max dimension for extracted frames |
| `format` | string | jpeg | Output format for keyframes |
| `response_type` | string | base64 | base64 or file |

**Response (202 Accepted):**
```json
{
  "taskId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "queued",
  "progressUrl": "/v1/process/progress/550e8400-..."
}
```

### 7.3 POST /v1/process/image

Synchronous image processing.

**Request:**
- `multipart/form-data` with `file` field
- OR JSON with `base64` field

**Parameters:**
| Name | Type | Default | Description |
|------|------|---------|-------------|
| `max_dimension` | int | 1024 | Longest edge in pixels |
| `quality` | int | 85 | Output quality 1-100 |
| `format` | string | jpeg | jpeg, png, webp, avif, gif |
| `strip_exif` | bool | true | Remove EXIF data |
| `response_type` | string | base64 | base64 or file |

**Response (200 OK):**
```json
{
  "original_size_bytes": 5242880,
  "optimized_size_bytes": 102400,
  "width": 1024,
  "height": 768,
  "format": "jpeg",
  "base64": "data:image/jpeg;base64,..."
}
```

---

## 8. Configuration

All configuration via `config.json`. No `.env` defaults are used.

| Field | Required | Description |
|----------|---------|-------------|
| `server.port` | Yes | HTTP server port |
| `server.host` | No | Host to bind (default: 0.0.0.0) |
| `media.maxFileSizeMb` | No | Max upload size in MB (default: 300) |
| `media.gpu.platform` | **Yes** | GPU platform: `nvenc`, `vaapi`, `qsv`, `cpu` |
| `media.gpu.device` | No | GPU device index (default: 0) |
| `logging.level` | No | Log level: error, warn, info, debug (default: info) |
| `logging.logsDir` | **Yes** | Directory for log files |
| `logging.sessionPrefix` | No | Log file prefix (default: ms) |
| `logging.retentionDays` | No | Days to keep logs (default: 7) |
| `cache.dir` | No | Cache directory (default: ./cache/assets) |
| `cache.ttl` | No | Asset TTL in seconds (default: 3600) |
| `cache.maxSize` | No | Max cache size in bytes (default: 10GB) |
| `workers.maxConcurrentTasks` | No | Max parallel async tasks (default: 4) |
| `workers.mode` | No | Execution mode: `queue` or `thread` (default: queue) |
| `messaging.transport` | No | Transport: sse, ws, polling (default: sse) |

---

## 9. Error Handling

| HTTP Status | Code | Description |
|-------------|------|-------------|
| 400 | INVALID_REQUEST | Malformed request body |
| 400 | INVALID_OPTIONS | Invalid operation parameters |
| 404 | TASK_NOT_FOUND | Task does not exist |
| 404 | ASSET_NOT_FOUND | Asset does not exist |
| 409 | TASK_CONFLICT | Task already exists |
| 413 | FILE_TOO_LARGE | Upload exceeds max size |
| 415 | UNSUPPORTED_FORMAT | Input format not supported |
| 500 | PROCESSING_ERROR | Task processing failed |
| 503 | SERVICE_UNAVAILABLE | System overloaded |

---

## 10. Technology Stack

### Core Platform
- **Node.js 18+**: HTTP server, orchestration, task management
- **Native HTTP**: Node.js built-in `http` module with custom Router and multipart parser
- **Native FS**: Node.js built-in `fs` module for file operations
- **Worker Threads**: Node.js `worker_threads` for parallel processing (thread mode)

**Note**: No Express, Multer, fluent-ffmpeg, or FFmpeg CLI - the service uses custom lightweight implementations and native N-API modules.

### Bundled Modules (Submodules)
Located in `/modules`:
- **nLogger**: Structured logging with detailed formatting
- **nImage**: Native image processing (RAW, HEIC, 150+ formats via libraw/libheif/ImageMagick)
- **nVideo**: Native audio/video processing (direct FFmpeg library integration via N-API)
- **nui_wc2**: Web UI for monitoring and testing

### External Dependencies
- **FFmpeg libraries**: Linked by nVideo (avformat, avcodec, avutil, swscale, swresample, avfilter)
- **No FFmpeg CLI required**: nVideo replaces all CLI functionality

---

## 11. Acceptance Criteria

### Phase 1: Core Foundation ✅ COMPLETE
- [x] Node.js HTTP server with native `http` module (no Express/Multer)
- [x] Custom multipart parser for file uploads
- [x] Task system (create, status, queue, workers)
- [x] SSE messaging adapter (ProgressReporter decoupled via Sender interface)
- [x] Basic asset caching with TTL

### Phase 2: Image Processing ✅ COMPLETE
- [x] nImage for all image processing (resize, crop, convert, strip_exif)
- [x] HEIC/HEIF support via libheif (part of nImage)
- [x] RAW format support (CR2, ORF, NEF, ARW, DNG, etc.) via nImage/libraw

### Phase 3: Audio/Video Processing (FFmpeg CLI) ✅ COMPLETE → REPLACED
- [x] FFmpeg CLI integration (custom wrapper, not fluent-ffmpeg) - *superseded by nVideo*
- [x] Audio transcoding/resampling (MP3, WAV, OGG, M4A) - *migrated to nVideo*
- [x] Video audio extraction - *migrated to nVideo*
- [x] Video keyframe extraction - *migrated to nVideo*
- [x] GPU acceleration (NVENC, VAAPI, QSV) with auto-selection - *migrated to nVideo*
- [x] File-based processing for reliability - *retained with nVideo*
- [x] Progress parsing from FFmpeg stderr - *replaced by nVideo native callbacks*

### Phase 4: nVideo Integration ✅ COMPLETE
- [x] Add nVideo as git submodule (`/modules/nVideo`)
- [x] Rewrite AudioProcessor to use nVideo (`transcode()`, `extractAudio()`, `probe()`)
- [x] Rewrite VideoProcessor to use nVideo (`extractAudio()`, `thumbnail()`, `transcode()`)
- [x] Remove FFmpeg CLI wrapper (`src/utils/ffmpeg/`)
- [x] Remove FFmpeg binary dependency (`bin/ffmpeg.exe`)
- [x] Add configurable worker execution mode (`queue` vs `thread`)
- [x] Implement TaskWorker for thread mode (`src/tasks/TaskWorker.js`)

### Phase 5: Advanced Features 🔄 PARTIAL
- [x] REST polling adapter (`GET /v1/jobs/:jobId`)
- [x] Cache size management (LRU eviction in AssetCache)
- [ ] WebSocket messaging adapter
- [ ] Task retry logic with exponential backoff
- [ ] Adaptive sync/async logic (auto-detect based on file size)
