# Media Service API Documentation

**Media Service** is a stateless microservice that preprocesses multimedia files for Large Language Model (LLM) consumption. It receives large files and returns downscaled, compressed, LLM-friendly versions via GPU-accelerated processing (NVENC, VAAPI, QSV).

## Table of Contents

- [Quick Start](#quick-start)
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
| `X-Original-Filename` | Yes | Used for format detection |
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

**Error Responses:**

| Status | Meaning |
|--------|---------|
| 400 | Missing fileId or input_path |
| 404 | fileId not found |
| 403 | input_path not in allowed paths |
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
event: start
data: {"event":"start","jobId":"job-def-456","processor":"audio"}

event: progress
data: {"event":"progress","jobId":"job-def-456","percent":25,"message":"Transcoding..."}

event: complete
data: {"event":"complete","jobId":"job-def-456","assetId":"asset-ghi-789","metadata":{...}}

event: error
data: {"event":"error","jobId":"job-def-456","error":"Processing failed"}
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
  "retrievedAt": null,
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
| `{ "type": "subscribed", "jobId": "..." }` | Subscription confirmed |
| `{ "type": "progress", "jobId": "...", "percent": 50, "message": "..." }` | Progress update |
| `{ "type": "complete", "jobId": "...", "assetId": "..." }` | Job complete |
| `{ "type": "error", "jobId": "...", "error": "..." }` | Job failed |
| `{ "type": "pong", "timestamp": 1234567890 }` | Heartbeat pong |
| Binary frames | Download data (after download_request) |

**Binary Upload Workflow:**

```
1. Client → { type: "upload_start", uploadId: "...", filename: "...", size: 12345 }
2. Client → [binary chunks...]
3. Client → { type: "upload_complete", uploadId: "..." }
4. Server → { type: "upload_ready", fileId: "...", detectedType: "..." }
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
| `max_dimension` | number | 1024 | Longest edge constraint (64-4096) |
| `quality` | number | 85 | Output quality 1-100 |
| `format` | string | jpeg | Output format: jpeg, png, webp, avif, gif |
| `strip_exif` | boolean | true | Strip EXIF metadata |
| `crop` | object | - | Crop configuration |

**Crop Options:**

```json
{
  "crop": {
    "type": "region",
    "x": 0.25, "y": 0.25, "width": 0.5, "height": 0.5
  }
}
```

Crop types: `region` (normalized coords 0-1), `center` (% of image), `grid` (cell extraction)

---

### Audio Processing

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `sample_rate` | number | 16000 | Output sample rate: 8000, 16000, 22050, 44100, 48000 |
| `channels` | number | 1 | Output channels: 1 (mono) or 2 (stereo) |
| `format` | string | mp3 | Output format: mp3, wav, ogg, m4a |
| `audio_codec` | string | auto | Specific codec (from capabilities) |

---

### Video Processing

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `mode` | string | extract_audio | Processing mode |
| `fps` | number | 1 | Frame rate for keyframe extraction (1-30) |
| `max_dimension` | number | 1024 | Max frame dimension for keyframes |
| `output_format` | string | mp4 | Container: mp4, webm, mkv, mov |
| `video_codec` | string | libx264 | Video codec |
| `audio_codec` | string | aac | Audio codec |
| `hwaccel` | string | - | Hardware acceleration: nvenc, qsv, vaapi |
| `crf` | number | 23 | Quality factor (0-51) |
| `preset` | string | medium | Encoding preset (ultrafast to veryslow) |
| `width` | number | - | Output width |
| `height` | number | - | Output height |

**Video Modes:**

| Mode | Description |
|------|-------------|
| `extract_audio` | Extract audio track from video |
| `extract_keyframes` | Extract keyframes at specified FPS |
| `transcode` | Full video transcode with codec options |

---

## Error Handling

### HTTP Status Codes

| Status | Meaning |
|--------|---------|
| 200 | Success |
| 202 | Accepted (async task queued) |
| 400 | Bad request |
| 404 | Not found |
| 413 | File too large |
| 415 | Unsupported format |
| 5XX | Processing error |

### Error Response Format

```json
{
  "error": "Processing failed: unsupported format"
}
```

---

## Configuration

All configuration is managed via `config.json` in the project root.

**Required fields:**

| Field | Description |
|-------|-------------|
| `server.port` | HTTP server port |
| `logging.logsDir` | Log directory path |
| `media.gpu.platform` | GPU platform: nvenc, vaapi, qsv, cpu |

**Key optional fields:**

| Field | Default | Description |
|-------|---------|-------------|
| `media.maxFileSizeMb` | 500 | Maximum upload size (MB) |
| `media.allowedInputPaths` | [] | Allowed paths for input_path processing |
| `workers.mode` | thread | Worker execution mode: thread or queue |
| `workers.concurrency` | 2 | Max concurrent workers |
| `cache.ttl` | 3600 | Asset cache TTL (seconds) |
| `cache.maxSizeMb` | 10240 | Max cache size (MB) |

See `config.json` for full configuration reference.

---

## See Also

- [ARCHITECTURE.md](ARCHITECTURE.md) - Detailed architecture and component overview
- [CAPABILITIES.md](CAPABILITIES.md) - Full capabilities endpoint documentation
- [PROCESSING.md](PROCESSING.md) - Processing workflows and native module details
