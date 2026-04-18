# Media Service - Specification

## 1. Overview

Media Service is a stateless microservice designed to preprocess multimedia files for Large Language Model (LLM) consumption. It receives large files and returns downscaled, compressed, LLM-friendly versions. GPU acceleration is utilized when available (NVENC, VAAPI, QSV).

### Platform Decisions

- **Orchestration**: Node.js (HTTP server, task management, messaging)
- **Image Processing**: Native NAPI bindings (nImage with libraw/libheif/ImageMagick)
- **Audio/Video Processing**: Native NAPI bindings (nVideo with direct FFmpeg library integration)
- **Transport**: HTTP for control, SSE/WebSocket for progress, raw binary for uploads
- **Worker Isolation**: Thread mode (`worker_threads`) is the default for native module safety

### Processing Modes

| Category | Operations | Execution |
|----------|------------|-----------|
| Image | Convert, crop, resize, format | Async via unified pipeline |
| Audio | Transcode, resample | Async via unified pipeline |
| Video | Extract audio, extract keyframes, transcode | Async via unified pipeline |

---

## 2. Architecture

### 2.1 Component Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        Media Service                             │
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

### 2.2 Native Binding Strategy

#### Image Processing (nImage - Native NAPI)
- **LibRaw**: RAW formats (CR2, NEF, ARW, ORF, DNG, etc.)
- **LibHeif**: HEIC/HEIF/AVIF formats
- **Sharp/libvips**: Standard formats (JPEG, PNG, WebP, GIF, TIFF, AVIF) + transforms
- **ImageMagick**: 150+ additional formats (PDF, SVG, EXR, HDR, etc.)
- **Capabilities**: Resize, crop, format conversion, EXIF stripping, region extraction

#### Audio/Video Processing (nVideo - Native NAPI)
- Direct FFmpeg C API (`avformat`, `avcodec`, `avfilter`, `swscale`, `swresample`)
- File-to-file transcoding runs entirely in C++ (no JS involvement during processing)
- Automatic GPU codec selection based on `config.media.gpu.platform`
- Audio filter graphs (`abuffer → aformat → asetnsamples → abuffersink`)
- Native progress callbacks (percent, speed, bitrate, ETA, frame counts)

---

## 3. Data Flow

### ID Chain

```
fileId (upload) ──► jobId (processing) ──► assetId (result)
```

All three IDs are tracked in `JobStore`:
- `fileId` → temp file path, detected type, upload time
- `jobId` → task state, progress, worker assignment
- `assetId` → output file path, metadata, retrieval status

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

---

## 4. API Specification

### 4.1 Unified Transport Endpoints (Recommended)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/v1/upload` | Stream raw binary upload. Requires `Content-Length`. Returns `fileId` |
| `POST` | `/v1/process` | Start processing from `fileId` or `input_path`. Returns `jobId` |
| `GET` | `/v1/jobs/:jobId/progress` | SSE progress stream (start, progress, complete, error) |
| `GET` | `/v1/jobs/:jobId` | Poll job status and current progress |
| `DELETE` | `/v1/jobs/:jobId` | Cancel a queued job |
| `GET` | `/v1/capabilities` | Query nVideo/nImage codecs, filters, formats, hwaccels |
| `WS` | `/v1/ws` | WebSocket for progress, binary upload, and binary download |

#### POST /v1/upload

**Headers:**
| Header | Required | Description |
|--------|----------|-------------|
| `Content-Type` | Yes | `application/octet-stream` |
| `Content-Length` | Yes | Enables pre-flight disk space check |
| `X-Original-Filename` | Yes | Used for format detection (sanitized) |
| `X-Upload-Id` | No | Idempotency key for retry-safe uploads |

**Response (200):**
```json
{
  "fileId": "upload-abc-123",
  "size": 14466896,
  "detectedType": "audio",
  "detectedMimeType": "audio/wav",
  "expiresAt": "2026-04-17T05:45:29.303Z",
  "status": "ready"
}
```

**Response errors:** 411 (missing Content-Length), 413 (too large), 415 (unsupported format), 507 (insufficient disk space)

#### POST /v1/process

**Request body:**
```json
{
  "fileId": "upload-abc-123",
  "processor": "audio",
  "options": {
    "sample_rate": 16000,
    "channels": 1,
    "format": "mp3"
  }
}
```

Or with path:
```json
{
  "input_path": "D:\\Media\\input.wav",
  "processor": "audio",
  "options": {
    "sample_rate": 16000,
    "channels": 1,
    "format": "mp3"
  }
}
```

**Response (200):**
```json
{
  "jobId": "job-def-456",
  "status": "queued",
  "queuePosition": 1
}
```

#### SSE Progress Format

```
event: start
data: {"event":"start","jobId":"job-def-456","processor":"audio"}

event: progress
data: {"event":"progress","jobId":"job-def-456","percent":25,"message":"Transcoding..."}

event: complete
data: {"event":"complete","jobId":"job-def-456","assetId":"asset-ghi-789","metadata":{...}}
```

#### WebSocket Messages

**Client → Server:**
```json
{ "type": "subscribe", "jobId": "job-def-456" }
{ "type": "unsubscribe", "jobId": "job-def-456" }
{ "type": "ping" }
```

**Server → Client:**
```json
{ "type": "connected", "id": "conn-uuid" }
{ "type": "subscribed", "jobId": "job-def-456" }
{ "type": "progress", "jobId": "job-def-456", "percent": 50, "message": "Transcoding..." }
{ "type": "complete", "jobId": "job-def-456", "assetId": "asset-ghi-789" }
{ "type": "error", "jobId": "job-def-456", "error": "..." }
{ "type": "pong", "timestamp": 1234567890 }
```

### 4.1.1 Capabilities Endpoint

`GET /v1/capabilities` returns runtime capabilities from the native modules (nVideo and nImage). This allows clients to discover available codecs, formats, filters, and hardware acceleration at runtime.

**Query Parameters:**

| Parameter | Values | Description |
|-----------|--------|-------------|
| `module` | `nvideo`, `nimage` | Filter to specific module. Omit for both. |
| `section` | See below | Filter to specific capability section |

**nVideo sections:**
- `build` - FFmpeg version, configuration, protocols, hwaccels
- `codecs` - All available codecs (786+)
- `common` - Curated encoder/decoder lists by hardware type
- `filters` - All available filters (568+)
- `formats` - All container formats (416+)
- `hwaccels` - Hardware acceleration info with recommended presets

**nImage sections:**
- `formats` - All supported input formats
- `state` - Module load state (isLoaded, hasSharp, version)
- `raw` - RAW format list (LibRaw)
- `heic` - HEIC/AVIF format list (LibHeif)
- `imagemagick` - ImageMagick fallback format list

**Response (200):**
```json
{
  "success": true,
  "data": {
    "nVideo": {
      "buildInfo": { "version": "7.1", "hwaccels": ["nvenc", "qsv"], ... },
      "commonCodecs": {
        "encoders": { "video": { "cpu": [...], "nvidia": [...] }, "audio": [...] },
        "decoders": { "video": [...], "audio": [...] },
        "videoEncodersByHwaccel": { "cpu": [...], "nvidia": [...] },
        "recommended": { "webStreaming": {...}, "archiving": {...} }
      },
      "filters": [...],
      "formats": [...]
    },
    "nImage": {
      "version": { "major": 0, "minor": 1, "patch": 0 },
      "decoders": {
        "raw": { "library": "libraw", "formats": [...], "features": [...] },
        "heic": { "library": "libheif", "formats": [...], "features": [...] },
        "sharp": { "library": "sharp/libvips", "formats": [...], "features": [...] },
        "magick": { "library": "imagemagick", "formats": [...], "features": [...] }
      },
      "encoders": ["jpeg", "png", "webp", "avif", "tiff"]
    },
    "nImageState": {
      "isLoaded": true,
      "hasSharp": true,
      "version": { "major": 0, "minor": 1, "patch": 0 },
      "supportedFormats": [...],
      "rawFormats": [...],
      "heicFormats": [...],
      "imagemagickFormats": [...]
    }
  }
}
```

### 4.2 Asset Cache Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/v1/assets` | List cached assets |
| `GET` | `/v1/assets/:id` | Download asset file |
| `GET` | `/v1/assets/:id/metadata` | Get asset metadata |
| `DELETE` | `/v1/assets/:id` | Delete specific asset |
| `DELETE` | `/v1/assets` | Clear all assets |

### 4.3 Legacy Endpoints

The following legacy endpoints are still functional but superseded by the unified transport:

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/v1/process/image` | Synchronous image processing (multipart or base64) |
| `POST` | `/v1/process/image/crop` | Synchronous image cropping |
| `POST` | `/v1/process/audio` | Audio processing (multipart or base64) |
| `POST` | `/v1/process/video` | Video processing (multipart or base64) |
| `POST` | `/v1/audio/probe` | Probe audio metadata |

### 4.4 System Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Health check with processor readiness |

---

## 5. Processing Options

### Images
- `max_dimension`: Longest edge constraint (default 1024px)
- `quality`: Output quality 1-100 (default 85)
- `format`: jpeg, png, webp, avif, gif
- `crop`: region (normalized coords), center (% of image), grid (cell extraction)

### Audio
- `sample_rate`: 8000, 16000, 22050, 44100, 48000 Hz (default 16000)
- `channels`: 1 (mono) or 2 (stereo), default mono
- `format`: mp3, wav, ogg, m4a

### Video
- `mode`: `extract_audio`, `extract_keyframes`, or `transcode`
- `fps`: Frame rate for keyframe extraction (1-30)
- `max_dimension`: Max frame dimension for extracted keyframes
- `output_format`: Container format (mp4, webm, mkv, mov)
- `video_codec`: Video codec (libx264, libx265, h264_nvenc, etc.)
- `audio_codec`: Audio codec (aac, libmp3lame, libopus, copy)
- `hwaccel`: Hardware acceleration (nvenc, qsv, vaapi)
- `crf`: Quality factor (0-51, default 23)
- `preset`: Encoding speed preset (ultrafast to veryslow)
- `width`, `height`: Optional output dimensions

---

## 6. Task System

### Worker Execution Modes

Configured via `workers.mode` in `config.json`:

| Mode | Behavior | Use Case |
|------|----------|----------|
| `thread` (default) | Each task spawns a `worker_thread` | True parallelism, protects main process from native panics |
| `queue` | Tasks run on main thread, serialized | Simpler, lower memory footprint |

**Thread mode is the default and strongly recommended** for audio/video processing. A native module panic in nVideo will kill only the worker thread, not the main process.

### Job Store & Persistence

`JobStore` (`src/jobs/JobStore.js`) provides disk-backed persistence:
- Jobs and uploads are persisted to `./cache/jobs/jobs.json`
- On startup: processing jobs are marked `failed`, queued jobs are re-queued
- Uploads have a 1-hour TTL if never processed
- Background cleanup runs periodically

### Progress Reporter

`ProgressReporter` (`src/pipeline/ProgressReporter.js`) is transport-agnostic:
- Implements a generic `Sender` interface
- Supports both `SseConnection` and `WebSocketConnection`
- Links external connections to internal job IDs for forwarding

---

## 7. Asset Cache

### Asset Model

```javascript
{
  id: string,
  type: 'image' | 'audio' | 'video',
  mimeType: string,
  size: number,
  storagePath: string,
  createdAt: timestamp,
  expiresAt: timestamp,
  retrievedAt: timestamp|null,
  metadata: object
}
```

### Cache Management

- **Storage**: Local disk (`./cache/assets/`)
- **Default TTL**: 1 hour (configurable)
- **Retrieved TTL**: 0 (immediate cleanup on next cycle)
- **Max Cache Size**: 10GB (configurable)
- **Cleanup**: Background job every 5 minutes
- **Range Support**: `GET /v1/assets/:id` supports HTTP Range requests

---

## 8. Security & Resource Constraints

### Path Validation
- `input_path` must start with a prefix from `config.media.allowedInputPaths`
- Pre-flight `fs.access(path, fs.constants.R_OK)` check before queuing
- UNC paths blocked unless explicitly allowed

### Upload Resource Management
- `Content-Length` header is **required** — enables pre-flight disk space check
- Upload concurrency limited by config
- Partial uploads are cleaned up on connection abort
- Magic byte validation runs after upload completes

### GPU Slot Management
- NVENC has max concurrent sessions (3-5 on consumer cards)
- Configurable `media.gpu.maxConcurrentSessions`

---

## 9. Error Handling Contract

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

## 10. Known Issues & Notes

### Upload Handler `end`/`close` Race
Fixed in `src/api/routes/upload.js`: the `rawRequest` `close` event was destroying the write stream after the `end` event had already fired, causing the stream `finish` event to never emit and the upload promise to hang indefinitely. A `requestEnded` flag now prevents the `close` handler from interfering with successful completions.

### ESM Worker Loading
Native modules (nVideo, nImage) are loaded in worker threads via `createRequire(import.meta.url)` because `worker_threads` in ESM mode does not support direct `require()`.

### Progress Completion & assetId
`PipelineExecutor.execute()` sends a `complete` progress event before the result is cached. `Worker.js` now sends a follow-up `complete` event containing the actual `assetId` after caching. WebSocket and SSE clients should listen for the event that includes `assetId`.
