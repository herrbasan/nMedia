# Media Service - Specification

## 1. Overview

Media Service is a comprehensive media processing microservice built on **Node.js** as the orchestration and HTTP platform. It provides both synchronous operations for low-latency needs and asynchronous operations for heavy media tasks. GPU acceleration (NVENC, CUDA) is utilized when available.

### Platform Decisions

- **Orchestration**: Node.js (HTTP server, task management, messaging)
- **Image Processing**: Native NAPI bindings (nImage with libraw/libheif/Sharp/ImageMagick)
- **Audio/Video Processing**: FFmpeg CLI (fluent-ffmpeg wrapper, future: custom CLI wrapper or NAPI)
- **Hybrid Architecture**: NAPI for images (fast, universal format support), CLI for A/V (full feature access)

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
│  │  │ (Sharp/     │  │ (FFmpeg     │  │ (FFmpeg             │  │  │
│  │  │  libvips)   │  │  NAPI)      │  │  NAPI)              │  │  │
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

#### Audio/Video Processing (FFmpeg CLI)
- **Why**: Full CLI capability access, familiar interface
- **Current**: FFmpeg CLI via fluent-ffmpeg wrapper
- **Future**: Custom CLI wrapper for direct command control
- **Capabilities**:
  - Decode: Any format FFmpeg supports
  - Encode: All major codecs (H264, VP9, Opus, MP3, AAC, etc.)

---

## 3. Task System

### 3.1 Task Model

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
  createdAt: number,             // Unix timestamp
  startedAt: number,             // Unix timestamp
  completedAt: number,           // Unix timestamp
  error: string,                 // Error message if failed
}
```

### 3.2 Task Lifecycle

```
[Create] → [Pending] → [Running] → [Completed]
                           ↓
                       [Failed]
                           ↓
                      [Cancelled]
```

### 3.3 Task System Implementation

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

### 3.4 Supported Operations

**Image (Sync)**
- `resize` - Scale to max dimension while preserving aspect ratio
- `crop` - Region, center, or grid-based cropping
- `convert` - Format conversion (jpeg, png, webp, avif, gif, heic)
- `quality` - Adjust compression quality
- `strip_exif` - Remove EXIF metadata

**Video (Async)**
- `transcode` - Convert to different codec/format
- `resize` - Scale resolution
- `crop` - Crop by region or time range
- `extract_audio` - Strip audio track to audio file
- `extract_keyframes` - Extract frames at specified FPS
- `extract_thumbnails` - Generate thumbnail sprites

**Audio (Async)**
- `transcode` - Convert to different format
- `resample` - Change sample rate
- `channels` - Convert stereo/mono
- `trim` - Cut by start/end time

**Video Streaming (Real-time)**
- `stream` - Real-time transcode and serve via streaming response

**Audio Streaming (Real-time)**
- `stream` - Real-time resample and serve via streaming response

### 3.4 Task Queue

- In-memory queue with priority support
- Configurable max concurrent workers
- Automatic retry with exponential backoff (max 3 attempts)
- Dead letter handling for permanently failed tasks

---

## 4. Messaging Layer

### 4.1 Unified Message Interface

All transports implement the same message interface:

```javascript
{
  type: 'task_created' | 'progress' | 'completed' | 'error' | 'cancelled',
  taskId: string,
  timestamp: ISO8601,
  payload: object,
}
```

### 4.2 Transport Adapters

**SSE (Server-Sent Events)**
- Best for: Browser clients, simple integration
- Endpoint: `GET /v1/tasks/events`
- Authentication: Connection token query param

**WebSocket**
- Best for: Bidirectional communication, lower latency
- Endpoint: `WS /v1/tasks/ws`
- Authentication: Initial handshake token

**REST Polling**
- Best for: Firewalls, simple clients, debugging
- Endpoint: `GET /v1/tasks/:id/status`
- Polling interval: Client-controlled

### 4.3 Message Types

| Type | Payload | Description |
|------|---------|-------------|
| `task_created` | `{ taskId, type, operation }` | Task was queued |
| `progress` | `{ percent, stage, message }` | Task progress update |
| `completed` | `{ taskId, assetId, result }` | Task finished successfully |
| `error` | `{ taskId, code, message }` | Task failed |
| `cancelled` | `{ taskId }` | Task was cancelled |

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
- **Max Cache Size**: 10GB (configurable)
- **Cleanup**: Background job every 5 minutes
- **Naming**: `{asset_id}.{extension}`

### 5.3 Cache Endpoints

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
| `POST` | `/v1/optimize/image` | Process image synchronously |
| `POST` | `/v1/optimize/image/crop` | Crop image synchronously |

### 6.3 Streaming Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/v1/media/video/stream` | Start video streaming session |
| `POST` | `/v1/media/audio/stream` | Start audio streaming session |

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
| `WS` | `/v1/ws` | WebSocket connection |

---

## 7. Detailed Endpoint Specifications

### 7.1 POST /v1/tasks

Create an async task.

**Request:**
```json
{
  "type": "video",
  "operation": "transcode",
  "input": {
    "source": "upload"
  },
  "options": {
    "format": "mp4",
    "codec": "h264",
    "quality": "high"
  },
  "ttl": 3600
}
```

**Response (202 Accepted):**
```json
{
  "taskId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "queued",
  "createdAt": "2026-04-03T07:14:00Z"
}
```

### 7.2 POST /v1/optimize/image

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

### 7.3 POST /v1/media/video/stream

Start a real-time video processing stream.

**Request:**
```json
{
  "input": {
    "source": "upload",
    "format": "mp4"
  },
  "output": {
    "format": "webm",
    "codec": "vp9",
    "width": 1280,
    "height": 720
  }
}
```

**Response (200 OK):**
- Streams raw media data with appropriate Content-Type
- Connection remains open until client disconnects

### 7.4 GET /v1/tasks/:id/status

Polling endpoint for task status.

**Response:**
```json
{
  "taskId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "processing",
  "progress": {
    "percent": 45,
    "stage": "transcoding",
    "message": "Encoding video..."
  },
  "createdAt": "2026-04-03T07:14:00Z",
  "updatedAt": "2026-04-03T07:14:30Z"
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
| `media.ffmpegPath` | No | Custom FFmpeg path |
| `media.gpu.platform` | **Yes** | GPU platform: `nvenc`, `vaapi`, `cpu` |
| `media.gpu.device` | No | GPU device index (default: 0) |
| `logging.level` | No | Log level: error, warn, info, debug (default: info) |
| `logging.logsDir` | **Yes** | Directory for log files |
| `logging.sessionPrefix` | No | Log file prefix (default: ms) |
| `logging.retentionDays` | No | Days to keep logs (default: 7) |
| `cache.dir` | No | Cache directory (default: ./cache/assets) |
| `cache.ttl` | No | Asset TTL in seconds (default: 3600) |
| `cache.maxSize` | No | Max cache size in bytes (default: 10GB) |
| `workers.maxConcurrentTasks` | No | Max parallel async tasks (default: 4) |
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
- **Custom multipart parser**: Minimal implementation for file uploads

**Note**: No Express or Multer - the service uses a custom lightweight HTTP server implementation.

### Bundled Modules (Submodules)
Located in `/modules`:
- **nLogger**: Structured logging with detailed formatting
- **nImage**: Native image processing (RAW, HEIC, 150+ formats via libraw/libheif/ImageMagick)
- **ffmpeg-napi-interface**: FFmpeg NAPI bindings for audio/video (future use)
- **nui_wc2**: Web UI for monitoring and testing

### External Dependencies
- **FFmpeg CLI**: Video/audio processing
- **@ffmpeg-installer/ffmpeg**: FFmpeg binary installer

---

## 11. Acceptance Criteria

### Phase 1: Core Foundation
- [x] Node.js HTTP server with native `http` module (no Express/Multer)
- [x] Custom multipart parser for file uploads
- [x] Task system (create, status, queue, workers) - **IMPLEMENTED**
- [x] SSE messaging adapter (ProgressReporter decoupled via Sender interface)
- [x] Basic asset caching with TTL

### Phase 2: Image Processing
- [x] nImage for all image processing (resize, crop, convert, strip_exif)
- [x] HEIC/HEIF support via libheif (part of nImage)
- [x] RAW format support (CR2, ORF, NEF, ARW, DNG, etc.) via nImage/libraw
- [ ] Custom libvips NAPI binding (future enhancement)
- [ ] Native HEIF/AVIF decoder without external dependencies (future enhancement)

### Phase 3: Audio/Video NAPI
- [ ] FFmpeg libs NAPI binding (avcodec, avformat, swresample)
- [ ] Audio decode/encode/transcode
- [ ] Video decode/encode/transcode
- [ ] Frame-level streaming API for real-time ops

### Phase 4: Advanced Operations
- [ ] Video streaming endpoint
- [ ] Audio streaming endpoint
- [ ] WebSocket messaging adapter
- [ ] REST polling adapter
- [ ] Task retry logic
- [ ] Cache size management
