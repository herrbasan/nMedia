# Media Service API Documentation

**Media Service** is a stateless microservice that preprocesses multimedia files for Large Language Model (LLM) consumption. It receives large files and returns downscaled, compressed, LLM-friendly versions via GPU-accelerated processing (NVENC, VAAPI, QSV).

## Table of Contents

- [Quick Start](#quick-start)
- [Web UI](#web-ui)
- [Architecture](#architecture)
- [API Reference](#api-reference)
  - [Upload](#upload)
  - [Process](#process)
  - [Job Management](#job-management)
  - [Progress Tracking](#progress-tracking)
  - [Asset Retrieval](#asset-retrieval)
  - [Capabilities](#capabilities)
  - [WebSocket](#websocket)
- [Processing Options](#processing-options)
  - [Image](#image-processing)
  - [Audio](#audio-processing)
  - [Video](#video-processing)
- [Error Handling](#error-handling)
- [Configuration](#configuration)

---

## Quick Start

### Upload and Process

```javascript
// 1. Upload a file
const upload = await fetch('http://localhost:3501/v1/upload', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/octet-stream',
    'Content-Length': file.size.toString(),
    'X-Original-Filename': file.name,
  },
  body: file,
});
const { fileId } = await upload.json();

// 2. Start processing
const process = await fetch('http://localhost:3501/v1/process', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    fileId,
    processor: 'audio',
    options: { sample_rate: 16000, channels: 1, format: 'mp3' },
  }),
});
const { jobId } = await process.json();

// 3. Track progress via SSE
const source = new EventSource(`http://localhost:3501/v1/jobs/${jobId}/progress`);
source.onmessage = (e) => {
  const data = JSON.parse(e.data);
  if (data.event === 'complete') {
    console.log('Asset ID:', data.assetId);
    source.close();
  }
};

// 4. Download result
const response = await fetch(`http://localhost:3501/v1/assets/${assetId}`);
const blob = await response.blob();
```

### Path-Based Processing

```javascript
// Process a file already on the server's filesystem
const { jobId } = await fetch('http://localhost:3501/v1/process', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    input_path: 'D:\\Media\\input.wav',
    processor: 'audio',
    options: { sample_rate: 16000, format: 'mp3' },
  }),
}).then(r => r.json());
```

---

## Web UI

A built-in web interface is available at the service root (`http://localhost:PORT/`). It combines service monitoring with an interactive task explorer for finding optimal API configurations.

### Pages

| Page | Route | Purpose |
|------|-------|---------|
| **Dashboard** | `#page=dashboard` | Service health, active jobs, cache stats, recent activity table |
| **Task Explorer** | `#page=task-explorer` | Interactive tool: file dropzone, processor selector, all options exposed, live API command preview (curl/fetch/JSON), run test with SSE progress |
| **Job Monitor** | `#page=job-monitor` | Real-time job queue with progress bars, cancel/download actions |
| **System Tests** | `#page=system-tests` | End-to-end verification of upload, WebSocket, SSE, and API connectivity |
| **Cache Manager** | `#page=cache-manager` | Browse cached assets, view metadata, delete individual or clear all |

### Task Explorer

The primary purpose of the web UI is finding optimal settings for integration workflows:

1. **Input**: Drag & drop a file, or enter a server path. The dropzone attempts to parse the file path for file-to-file workflows.
2. **Processor**: Select image/audio/video — the options panel updates dynamically.
3. **Options**: All processor options are exposed as form controls. Values default to service defaults.
4. **API Preview**: Three tabs show the live-generated API request as curl, fetch, or JSON.
5. **Run**: Uploads file if needed, starts processing, subscribes to SSE progress, displays result with download link.
6. **Copy**: Copies the active command tab to clipboard.

The task explorer is **stateless** — no presets or saved configurations. Copy the command and integrate it into your workflow.

---

## Architecture

### ID Chain

```
fileId (upload) ──► jobId (processing) ──► assetId (result)
```

### Data Flow

```
Client ──POST /v1/upload──► Server (writes temp file)
                              │
                              ▼
                         Returns fileId
                              │
Client ──POST /v1/process──► Server (queues job)
                              │
                              ▼
                         Returns jobId
                              │
Client ──GET /v1/jobs/:id/progress (SSE)
     or WS /v1/ws (subscribe)
                              │
                              ▼
                    PipelineExecutor routes to:
                    ├── ImageProcessor (nImage)
                    ├── AudioProcessor (nVideo)
                    └── VideoProcessor (nVideo)
                              │
                              ▼
                    Result cached in AssetCache
                              │
                              ▼
                    Complete event with assetId
                              │
Client ──GET /v1/assets/:id──► Server (streams file)
```

### Native Modules

| Module | Purpose | Technology |
|--------|---------|------------|
| **nImage** | Image decode/encode | LibRaw, LibHeif, Sharp, ImageMagick |
| **nVideo** | Audio/Video processing | FFmpeg C API (libavformat, libavcodec, libavfilter) |

**GPU Platforms:** NVENC (NVIDIA), VAAPI (Linux), QSV (Intel), CPU (software)

---

## API Reference

### Upload

#### `POST /v1/upload`

Stream raw binary upload. Returns a `fileId` for processing.

**Headers:**

| Header | Required | Description |
|--------|----------|-------------|
| `Content-Type` | Yes | `application/octet-stream` |
| `Content-Length` | Yes | Enables pre-flight disk space check |
| `X-Original-Filename` | No | Used for format detection fallback (defaults to 'unknown') |
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

**Error Responses:**

| Status | Meaning |
|--------|---------|
| 411 | Missing Content-Length |
| 413 | File too large |
| 415 | Unsupported format |
| 507 | Insufficient disk space |

---

### Process

#### `POST /v1/process`

Start processing from `fileId` or `input_path`. Returns immediately with `jobId`.

**Request Body (fileId):**

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

**Request Body (path):**

```json
{
  "input_path": "D:\\Media\\input.wav",
  "processor": "audio",
  "options": {
    "sample_rate": 16000,
    "format": "mp3"
  },
  "output_path": "D:\\Media\\output\\result.mp3"
}
```

**Response (200):**

```json
{
  "jobId": "job-def-456",
  "status": "queued",
  "queuePosition": 1,
  "progress_url": "/v1/jobs/job-def-456/progress",
  "poll_url": "/v1/jobs/job-def-456"
}
```

**Error Responses:**

| Status | Meaning |
|--------|---------|
| 400 | Missing fileId or input_path |
| 403 | input_path or output_path not in allowed paths |
| 404 | fileId not found |
| 409 | Cannot cancel non-queued job |
| 415 | Unsupported processor type |

---

### Job Management

#### `GET /v1/jobs`

List all jobs.

**Response (200):**

```json
{
  "jobs": [
    {
      "jobId": "job-abc-123",
      "status": "completed",
      "processor": "audio",
      "percent": 100,
      "createdAt": "2026-04-17T05:45:29.303Z",
      "completedAt": "2026-04-17T05:45:35.123Z"
    }
  ],
  "total": 1
}
```

#### `GET /v1/jobs/active`

List active (queued/processing) jobs only.

#### `GET /v1/jobs/:jobId`

Get job status and current progress.

**Response (200):**

```json
{
  "jobId": "job-def-456",
  "status": "processing",
  "processor": "audio",
  "percent": 45,
  "message": "Transcoding...",
  "createdAt": "2026-04-17T05:45:29.303Z"
}
```

#### `DELETE /v1/jobs/:jobId`

Cancel a queued job.

**Response (200):**

```json
{
  "jobId": "job-def-456",
  "status": "cancelled"
}
```

---

### Progress Tracking

#### SSE: `GET /v1/jobs/:jobId/progress`

Server-Sent Events stream for real-time progress.

**Events:**

```
event: state
data: {"event":"state","jobId":"job-def-456","status":"processing","percent":25,"message":"Transcoding..."}

event: start
data: {"event":"start","jobId":"job-def-456","processor":"audio"}

event: progress
data: {"event":"progress","jobId":"job-def-456","percent":25,"message":"Transcoding..."}

event: complete
data: {"event":"complete","jobId":"job-def-456","assetId":"asset-ghi-789","metadata":{...}}

event: error
data: {"event":"error","jobId":"job-def-456","error":"Processing failed"}

event: cancelled
data: {"event":"cancelled","jobId":"job-def-456"}
```

---

### Asset Retrieval

#### `GET /v1/assets/:id`

Download asset file. Supports HTTP Range requests for partial downloads.

**Response:** Binary file with appropriate `Content-Type` header.

#### `GET /v1/assets/:id/metadata`

Get asset metadata without downloading the file.

**Response (200):**

```json
{
  "id": "asset-ghi-789",
  "type": "audio",
  "mimeType": "audio/mpeg",
  "size": 456789,
  "createdAt": "2026-04-17T05:45:35.123Z",
  "expiresAt": "2026-04-17T06:45:35.123Z",
  "metadata": {
    "sampleRate": 16000,
    "channels": 1,
    "format": "mp3",
    "duration": 245.3
  }
}
```

#### `GET /v1/assets`

List all cached assets.

#### `DELETE /v1/assets/:id`

Delete specific asset.

#### `DELETE /v1/assets`

Clear all assets.

---

### Capabilities

#### `GET /v1/capabilities`

Query runtime capabilities from native modules (nVideo and nImage). Allows clients to discover available codecs, formats, filters, and hardware acceleration.

**Query Parameters:**

| Parameter | Values | Description |
|-----------|--------|-------------|
| `module` | `nvideo`, `nimage` | Filter to specific module. Omit for both. |
| `section` | See below | Filter to specific capability section |

**nVideo sections:**

| Section | Description |
|---------|-------------|
| `build` | FFmpeg version, configuration, protocols, hwaccels |
| `codecs` | All available codecs (786+) |
| `common` | Curated encoder/decoder lists by hardware type |
| `filters` | All available filters (568+) |
| `formats` | All container formats (416+) |
| `hwaccels` | Hardware acceleration info with recommended presets |

**nImage sections:**

| Section | Description |
|---------|-------------|
| `formats` | All supported input formats |
| `state` | Module load state (isLoaded, hasSharp, version) |
| `raw` | RAW format list (LibRaw) |
| `heic` | HEIC/AVIF format list (LibHeif) |
| `imagemagick` | ImageMagick fallback format list |

**Response (200):**

```json
{
  "success": true,
  "data": {
    "nVideo": {
      "buildInfo": { "version": "7.1", "hwaccels": ["nvenc", "qsv"], "protocols": [...] },
      "commonCodecs": {
        "encoders": {
          "video": { "cpu": ["libx264", "libx265"], "nvidia": ["h264_nvenc", "hevc_nvenc"] },
          "audio": ["aac", "libmp3lame", "libopus", "flac"]
        },
        "decoders": { "video": [...], "audio": [...] },
        "videoEncodersByHwaccel": { "cpu": [...], "nvidia": [...], "qsv": [...] },
        "recommended": {
          "webStreaming": { "video": "libx264", "audio": "aac" },
          "archiving": { "video": "libx265", "audio": "flac" },
          "modern": { "video": "libsvtav1", "audio": "libopus" },
          "fastest": { "video": "h264_nvenc", "audio": "aac" }
        }
      },
      "filters": [...],
      "formats": [...]
    },
    "nImage": {
      "version": { "major": 0, "minor": 1, "patch": 0 },
      "decoders": {
        "raw": { "library": "libraw", "formats": ["cr2", "nef", "arw", ...], "features": [...] },
        "heic": { "library": "libheif", "formats": ["heic", "heif", "avif"], "features": [...] },
        "sharp": { "library": "sharp/libvips", "formats": ["jpeg", "png", "webp", ...], "features": [...] },
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

**Example:**

```javascript
// Get only video codecs
const { data } = await fetch('/v1/capabilities?module=nvideo&section=common').then(r => r.json());
console.log(data.commonCodecs.encoders.video.cpu);

// Get image format support
const { data } = await fetch('/v1/capabilities?module=nimage&section=formats').then(r => r.json());
console.log(data); // Array of format names
```

---

### WebSocket

#### `WS /v1/ws`

WebSocket connection for progress tracking and binary transfer.

**Connection:** `ws://localhost:3501/v1/ws`

**Server → Client (on connect):**

```json
{ "type": "connected", "id": "conn-uuid" }
```

**Client → Server:**

| Message | Description |
|---------|-------------|
| `{ "type": "subscribe", "jobId": "..." }` | Subscribe to job progress |
| `{ "type": "unsubscribe", "jobId": "..." }` | Unsubscribe from job |
| `{ "type": "ping" }` | Heartbeat ping |
| Binary frames | Upload data (after upload_start) |

**Server → Client:**

| Message | Description |
|---------|-------------|
| `{ "type": "connected", "id": "..." }` | Sent immediately on connection |
| `{ "type": "state", "jobId": "...", "status": "...", "percent": 50 }` | Current job state (sent on subscribe) |
| `{ "type": "subscribed", "jobId": "..." }` | Subscription confirmed |
| `{ "type": "unsubscribed", "jobId": "..." }` | Unsubscription confirmed |
| `{ "type": "progress", "jobId": "...", "percent": 50, "message": "..." }` | Progress update |
| `{ "type": "complete", "jobId": "...", "assetId": "..." }` | Job complete |
| `{ "type": "error", "jobId": "...", "error": "..." }` | Job failed |
| `{ "type": "cancelled", "jobId": "..." }` | Job was cancelled |
| `{ "type": "pong", "timestamp": 1234567890 }` | Heartbeat pong |
| `{ "type": "upload_accepted", "uploadId": "..." }` | Upload accepted, ready for binary |
| Binary frames | Download data (after download_request) |

**Binary Upload Workflow:**

```
1. Client → { type: "upload_start", uploadId: "...", filename: "...", size: 12345 }
2. Server → { type: "upload_accepted", uploadId: "...", maxSize: ... }
3. Client → [binary chunks...]
4. Client → { type: "upload_complete", uploadId: "..." }
5. Server → { type: "upload_ready", fileId: "...", detectedType: "..." }
```

**Binary Download Workflow:**

```
1. Client → { type: "download_request", assetId: "..." }
2. Server → { type: "download_ready", assetId: "..." }
3. Server → [binary frames...]
4. Server → { type: "download_complete" }
```

---

## Processing Options

### Image Processing

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `max_dimension` | number | 1024 | Longest edge constraint (1-10000) |
| `quality` | number | 85 | Output quality 1-100 |
| `format` | string | jpeg | Output format: jpeg, png, webp, avif, gif |
| `strip_exif` | boolean | true | Strip EXIF metadata |
| `crop` | object | - | Crop configuration |
| `rotate` | number | - | Rotate: 90, 180, or 270 |
| `flip` | boolean | false | Vertical flip |
| `flop` | boolean | false | Horizontal flip |
| `grayscale` | boolean | false | Convert to grayscale |
| `normalize` | boolean | false | Normalize contrast |
| `blur` | number | 0 | Blur sigma (0-20) |

**Crop Options:**

```json
{
  "crop": {
    "type": "region",
    "left": 0.25, "top": 0.25, "right": 0.75, "bottom": 0.75
  }
}
```

Crop types:
- `region`: `{ left, top, right, bottom }` (normalized coords 0-1)
- `center`: `{ width, height }` (% of image, default 50)
- `grid`: `{ cols, rows, cells }` (cells is array of cell indices to extract)

---

### Audio Processing

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `sample_rate` | number/string | 16000 | Output sample rate: 8000, 16000, 22050, 44100, 48000, or `"source"` |
| `channels` | number/string | 1 | Output channels: 1, 2, or `"source"` |
| `format` | string | mp3 | Output format: mp3, wav, ogg, m4a, flac, aac, opus |

---

### Video Processing

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `mode` | string | extract_audio | Processing mode |
| `fps` | number | 1 | Frame rate for keyframe extraction (1-30) |
| `max_dimension` | number | 1024 | Max frame dimension for keyframes |
| `output_format` | string | mp4 | Container: mp4, webm, mkv, mov |
| `video_codec` | string | libx264 | Video codec (use `*_nvenc` / `*_qsv` for HW accel) |
| `audio_codec` | string | aac | Audio codec |
| `crf` | number | 23 | Quality factor (0-51) |
| `preset` | string | medium | Encoding preset (ultrafast to veryslow) |
| `width` | number | - | Output width |
| `height` | number | - | Output height |
| `videoOptions` | object | - | Arbitrary video encoder options (CLI mode) |
| `audioOptions` | object | - | Arbitrary audio encoder options (CLI mode) |
| `no_video` | boolean | false | Disable video stream (`-vn`) |
| `no_audio` | boolean | false | Disable audio stream (`-an`) |

**Video Modes:**

| Mode | Description |
|------|-------------|
| `extract_audio` | Extract audio track from video |
| `extract_keyframes` | Extract keyframes at specified FPS |
| `transcode` | Full video transcode with codec options |
| `cli` | FFmpeg CLI passthrough via `videoOptions`/`audioOptions` |

---

## Error Handling

### HTTP Status Codes

| Status | Meaning |
|--------|---------|
| 200 | Success |
| 202 | Accepted (async task queued) |
| 400 | Bad request |
| 404 | Not found |
| 409 | Conflict (cannot cancel active job) |
| 411 | Length required (missing Content-Length) |
| 413 | File too large |
| 415 | Unsupported format |
| 429 | Too many concurrent uploads |
| 507 | Insufficient disk space |
| 5XX | Processing error |

### Error Response Format

```json
{
  "error": "Processing failed: unsupported format"
}
```

---

## Configuration

All configuration is managed via `config.json` in the project root. Copy `config.example.json` to `config.json` and adjust paths for your environment. The config loader throws on missing required values — this is intentional. No defaults are provided for required fields.

**Required fields (validated at startup):**

| Field | Description |
|-------|-------------|
| `server.port` | HTTP server port |
| `logging.logsDir` | Log directory path |
| `media.gpu.platform` | GPU platform: nvenc, vaapi, qsv, cpu |
| `media.maxFileSizeMb` | Maximum upload size (MB) |
| `cache.dir` | Asset cache directory |
| `cache.ttl` | Asset cache TTL (seconds) |
| `cache.maxSize` | Max cache size (bytes) |
| `workers.mode` | Worker execution mode: `queue`, `thread`, or `process` |
| `workers.maxConcurrentTasks` | Max concurrent workers |

**Optional fields:**

| Field | Default | Description |
|-------|---------|-------------|
| `server.host` | `0.0.0.0` | Bind address |
| `server.maxConcurrentUploads` | 4 | Max concurrent upload streams |
| `media.allowedInputPaths` | [] | Allowed paths for input_path processing |
| `media.allowedOutputPaths` | [] | Allowed paths for output_path file writing |
| `media.gpu.device` | 0 | GPU device index |
| `media.gpu.maxConcurrentSessions` | 4 | Max concurrent GPU sessions |
| `media.allowUncPaths` | false | Allow UNC network paths |
| `logging.level` | info | Log level: info, warn, error, debug |
| `logging.sessionPrefix` | ms | Session log filename prefix |
| `logging.retentionDays` | 7 | Log retention period |
| `messaging.transport` | sse | Default messaging transport |

See `config.example.json` for full configuration reference.

---

## See Also

- [ARCHITECTURE.md](ARCHITECTURE.md) - Detailed architecture and component overview
- [CAPABILITIES.md](CAPABILITIES.md) - Full capabilities endpoint documentation
- [PROCESSING.md](PROCESSING.md) - Processing workflows and native module details
