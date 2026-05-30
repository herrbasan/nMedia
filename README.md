# nMedia

A stateless Node.js microservice for optimizing images, audio, and video for LLM consumption.

## Overview

nMedia receives large multimodal payloads, aggressively compresses/downscales them, and returns LLM-friendly formats. It uses native N-API modules for zero-process-spawning media processing.

## Tech Stack

- **Runtime:** Node.js 18+
- **HTTP Server:** Native Node.js `http` module with custom Router
- **Image Processing:** nImage (native NAPI with libraw/libheif/ImageMagick)
- **Audio/Video Processing:** nVideo (native NAPI with direct FFmpeg C API integration)
- **Uploads:** Raw binary streaming to `POST /v1/upload`

## API Endpoints

### New Architecture (Recommended)

#### `POST /v1/upload`
Stream raw binary upload. Returns a `fileId` for processing.

**Headers:**
- `Content-Length` (required)
- `X-Original-Filename` (optional)
- `X-Upload-Id` (optional, for idempotency)

**Response:**
```json
{
  "fileId": "upload-abc-123",
  "size": 52428800,
  "detectedType": "video",
  "detectedMimeType": "video/mp4",
  "expiresAt": "2026-04-16T20:00:00Z",
  "status": "ready"
}
```

#### `POST /v1/process`
Unified processing endpoint. Supports two patterns:

**Pattern A - Path-based:**
```json
{
  "input_path": "C:\\Media\\video.mp4",
  "processor": "video",
  "mode": "extract_audio",
  "options": { "format": "mp3" },
  "output_path": "C:\\Media\\output\\audio.mp3"
}
```

**Pattern B - Upload-based:**
```json
{
  "fileId": "upload-abc-123",
  "processor": "video",
  "mode": "extract_audio",
  "options": { "format": "mp3" }
}
```

**Response:**
```json
{
  "jobId": "job-xyz-789",
  "status": "queued",
  "progress_url": "/v1/jobs/job-xyz-789/progress",
  "poll_url": "/v1/jobs/job-xyz-789"
}
```

#### `GET /v1/jobs/:jobId/progress`
SSE endpoint for real-time progress.

#### `GET /v1/jobs/:jobId`
Polling endpoint for job status.

#### `DELETE /v1/jobs/:jobId`
Cancel a queued job.

### Legacy Endpoints

The following legacy endpoints still work for backward compatibility:

- `POST /v1/process/image` - Synchronous image processing
- `POST /v1/process/image/crop` - Image cropping
- `POST /v1/process/audio` - Synchronous audio processing
- `POST /v1/process/video` - Synchronous video processing
- `POST /v1/audio/probe` - Audio metadata probe

### Capabilities

- `GET /v1/capabilities` - Query native module capabilities (codecs, formats, hwaccels)
  - Query params: `module=nvideo|nimage`, `section=...`

### Asset Cache

- `GET /v1/assets` - List assets
- `GET /v1/assets/:id` - Download asset
- `GET /v1/assets/:id/metadata` - Asset metadata
- `DELETE /v1/assets/:id` - Delete asset
- `DELETE /v1/assets` - Clear all assets

### WebSocket

- `WS /v1/ws` - Real-time progress + binary upload/download

### System

- `GET /health` - Health check with processor status

## Configuration

All configuration is managed via `config.json` in the project root. Copy `config.example.json` to `config.json` and adjust paths for your environment. Required fields will throw an error at startup if missing.

```json
{
  "server": {
    "port": 3500,
    "host": "0.0.0.0"
  },
  "media": {
    "maxFileSizeMb": 500,
    "gpu": {
      "platform": "nvenc",
      "device": 0
    },
    "allowedInputPaths": [
      "C:\\Users\\dave\\Media\\input"
    ],
    "allowedOutputPaths": [
      "C:\\Users\\dave\\Media\\output"
    ]
  },
  "logging": {
    "level": "info",
    "logsDir": "./logs",
    "sessionPrefix": "ms",
    "retentionDays": 7
  },
  "cache": {
    "dir": "./cache/assets",
    "ttl": 3600,
    "maxSize": 10737418240
  },
  "workers": {
    "maxConcurrentTasks": 4,
    "mode": "process"
  },
  "messaging": {
    "transport": "sse"
  }
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `server.port` | Yes | HTTP server port |
| `server.host` | No | Host to bind (default: 0.0.0.0) |
| `media.maxFileSizeMb` | No | Max upload size in MB |
| `media.gpu.platform` | Yes | GPU platform: `nvenc`, `vaapi`, `qsv`, `cpu` |
| `media.gpu.device` | No | GPU device index (default: 0) |
| `media.allowedInputPaths` | No | Allowed directories for path-based processing |
| `logging.level` | No | Log level: error, warn, info, debug |
| `logging.logsDir` | Yes | Directory for log files |
| `cache.dir` | No | Cache directory |
| `cache.ttl` | No | Asset TTL in seconds |
| `cache.maxSize` | No | Max cache size in bytes (e.g. 10737418240 = 10GB) |
| `workers.maxConcurrentTasks` | No | Max parallel tasks |
| `workers.mode` | No | `queue`, `thread`, or `process` (default: queue). Use `process` for audio/video |
| `media.allowedOutputPaths` | No | Allowed directories for `output_path` writing |

## Quick Start

```bash
npm install
npm start
```

## Testing

```bash
# Processor unit tests
npm test

# End-to-end HTTP tests (requires running service)
npm run test:e2e
```

## Usage Examples

### Upload then process (browser/remote clients)

```bash
# 1. Upload file
curl -X POST http://localhost:3500/v1/upload \
  -H "Content-Length: $(stat -c%s video.mp4)" \
  -H "X-Original-Filename: video.mp4" \
  --data-binary @video.mp4

# 2. Process uploaded file
curl -X POST http://localhost:3500/v1/process \
  -H "Content-Type: application/json" \
  -d '{"fileId":"upload-xxx","processor":"video","mode":"extract_audio","options":{"format":"mp3"}}'

# 3. Stream progress
curl -N http://localhost:3500/v1/jobs/JOB_ID/progress
```

### Path-based processing (local/Electron clients)

```bash
curl -X POST http://localhost:3500/v1/process \
  -H "Content-Type: application/json" \
  -d '{"input_path":"C:\\Media\\photo.CR2","processor":"image","options":{"max_dimension":1024,"format":"jpeg"}}'
```

### Legacy image processing

```bash
curl -X POST http://localhost:3500/v1/process/image \
  -F "file=@photo.jpg" \
  -F "max_dimension=512" \
  -F "format=webp"
```

## Worker Modes

**Queue mode** (`"queue"`, default): Tasks run serialized on the main thread. Lower memory footprint. Suitable for image processing; use `process` for audio/video to isolate native crashes.

**Thread mode** (`"thread"`): Each task spawns a `worker_thread`. Native modules run off the main event loop, providing true parallelism.

**Process mode** (`"process"`, recommended for audio/video): Each task spawns a `child_process.fork`. Maximum isolation — a native crash in nVideo kills only the child process, not the main process or other workers.

## Web UI

A web interface for testing is available at `http://localhost:3500/` when the service is running.

See `nmedia-web/README.md` for UI details.
