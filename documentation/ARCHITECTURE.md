# Media Service Architecture

## Overview

Media Service is a Node.js microservice that preprocesses multimedia files for LLM consumption. It uses native NAPI modules (nImage, nVideo) for GPU-accelerated image, audio, and video processing.

## Component Diagram

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

## Core Components

### PipelineExecutor

**Location:** `src/pipeline/PipelineExecutor.js`

Singleton registry for media processors. Routes processing requests to the appropriate processor and coordinates progress reporting.

```javascript
// Registration
PipelineExecutor.register('image', new ImageProcessor());
PipelineExecutor.register('audio', new AudioProcessor());
PipelineExecutor.register('video', new VideoProcessor());

// Execution
const result = await PipelineExecutor.execute('audio', input, options, onProgress);
```

### Processors

All processors extend `src/pipeline/Processor.js` and implement:

| Method | Description |
|--------|-------------|
| `validateOptions(options)` | Validate processing options, throw on invalid |
| `process(input, options, onProgress)` | Main processing method |
| `probe(input)` | (Optional) Extract metadata before processing |

#### ImageProcessor

**Location:** `src/processors/image/ImageProcessor.js`

Uses nImage (native NAPI with libraw/libheif/ImageMagick support).

**Capabilities:**
- Resize with max dimension constraint
- Format conversion (JPEG, PNG, WebP, AVIF, GIF)
- Quality adjustment (1-100)
- EXIF stripping
- Region/center/grid cropping

**Input formats:** RAW (CR2, NEF, ARW, ORF, DNG, etc.), HEIC/HEIF/AVIF, 150+ formats via ImageMagick

#### AudioProcessor

**Location:** `src/processors/audio/AudioProcessor.js`

Uses nVideo (native NAPI with direct FFmpeg library integration).

**Capabilities:**
- Sample rate conversion (8k-48k Hz)
- Channel conversion (mono/stereo)
- Format conversion (MP3, WAV, OGG, M4A)
- Audio probing (metadata extraction)

**Processing flow:**
1. Probe input for source metadata
2. Transcode with audio filter graph: `abuffer → aformat → asetnsamples → abuffersink`
3. Return processed audio

#### VideoProcessor

**Location:** `src/processors/video/VideoProcessor.js`

Uses nVideo for all video operations.

**Processing modes:**

| Mode | Description | nVideo Method |
|------|-------------|---------------|
| `extract_audio` | Extract audio track | `nVideo.extractAudio()` |
| `extract_keyframes` | Extract frames at FPS | `nVideo.thumbnail()` loop |
| `transcode` | Full video transcode | `nVideo.transcode()` |

**GPU codec selection** based on `config.media.gpu.platform`:

| Platform | Video Decode | Video Encode |
|----------|--------------|--------------|
| `nvenc` | h264_cuvid, hevc_cuvid | h264_nvenc, hevc_nvenc, av1_nvenc |
| `vaapi` | h264_vaapi, hevc_vaapi | h264_vaapi, hevc_vaapi |
| `qsv` | h264_qsv, hevc_qsv | h264_qsv, hevc_qsv, av1_qsv |
| `cpu` | software | libx264, libx265, libsvtav1 |

### ProgressReporter

**Location:** `src/pipeline/ProgressReporter.js`

Transport-agnostic progress management via generic `Sender` interface.

**Supported transports:**
- SSE (`SseConnection`)
- WebSocket (`WebSocketConnection`)

**Job lifecycle events:**
1. `start` - Processing begun
2. `progress` - Percent complete with message
3. `complete` - Finished with assetId
4. `error` - Processing failed

### WebSocket Server

**Location:** `src/server/WebSocketServer.js`

Raw Node.js WebSocket implementation (no external `ws` dependency).

**Endpoint:** `/v1/ws`

**Features:**
- Progress subscription (`subscribe` / `unsubscribe`)
- Binary upload (`upload_start` → binary chunks → `upload_complete`)
- Binary download (`download_request` → file streamed in binary frames)
- Ping/pong heartbeat

### JobStore

**Location:** `src/jobs/JobStore.js`

Disk-backed job persistence and upload tracking.

**Features:**
- Jobs persisted to `./cache/jobs/jobs.json`
- On startup: processing jobs marked `failed`, queued jobs re-queued
- Uploads have 1-hour TTL if never processed
- Background cleanup runs periodically

### AssetCache

**Location:** `src/cache/AssetCache.js`

Stores processing results with TTL management.

**Configuration:**
- Storage: `./cache/assets/`
- Default TTL: 1 hour
- Retrieved TTL: 0 (immediate cleanup on next cycle)
- Max cache size: 10GB (configurable)
- Cleanup interval: 5 minutes

## Worker Execution Modes

Configured via `workers.mode` in `config.json`:

| Mode | Behavior | Use Case |
|------|----------|----------|
| `process` (default) | Each task spawns a `child_process.fork` | Maximum isolation — native crashes don't affect main process or other workers |
| `thread` | Each task spawns a `worker_thread` | True parallelism, lighter than process mode |
| `queue` | Tasks run on main thread, serialized by queue | Memory-constrained, simpler debugging |

**Process mode is strongly recommended** for audio/video. A native module panic in nVideo will kill only the child process, not the main process or other workers.

## Data Flow

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

## Security

### Path Validation
- `input_path` must start with a prefix from `config.media.allowedInputPaths`
- Pre-flight `fs.access(path, fs.constants.R_OK)` check before queuing
- UNC paths blocked unless explicitly allowed

### Upload Resource Management
- `Content-Length` header required for pre-flight disk space check
- Upload concurrency limited by config
- Partial uploads cleaned up on connection abort
- Magic byte validation after upload completes

### GPU Slot Management
- NVENC has max concurrent sessions (3-5 on consumer cards)
- Configurable via `media.gpu.maxConcurrentSessions`
