# Media Service - Development Plan

The **Media Processing Service (MPS)** is a standalone microservice built on **Node.js** as the orchestration platform. Its purpose is to receive multimodal payloads (images, audio, video), process them efficiently using native N-API bindings (nImage for images, nVideo for audio/video), and return optimized outputs. GPU acceleration is utilized when available.

---

## 1. Core Objectives

- **Node.js Orchestration:** HTTP server, task management, messaging, and coordination all run on Node.js
- **Unified Native Processing:** NAPI for all media - nImage for images, nVideo for audio/video
- **GPU Acceleration:** Utilize NVENC, VAAPI, QSV when available for faster encoding/decoding
- **Worker Isolation:** Thread mode (`worker_threads`) is the default to protect the main process from native module panics
- **Universal Format Support:** RAW (CR2, NEF, ORF, DNG), HEIC, AVIF, and all formats FFmpeg supports

---

## 2. Technology Stack

### Core Platform
- **Node.js 18+**: HTTP server, orchestration, task queue, messaging
- **Native HTTP**: Built-in `http` module with custom Router (no Express)
- **Child Processes**: Built-in `child_process.fork` for worker isolation (process mode)
- **Worker Threads**: Built-in `worker_threads` for parallel processing (thread mode)
- **Custom Multipart Parser**: Minimal implementation retained for legacy endpoints only

### Bundled Modules (Submodules in `/modules`)
| Module | Purpose |
|--------|---------|
| nLogger | Structured logging with detailed formatting |
| nImage | Native image processing (RAW, HEIC, 150+ formats via libraw/libheif/ImageMagick) |
| nVideo | Native audio/video processing (direct FFmpeg library integration via N-API) |
| nui_wc2 | Web UI for monitoring and testing |

### Media Processing

| Component | Technology | Rationale |
|-----------|------------|-----------|
| Image Processing | nImage (native NAPI) | Native libraw + libheif + Sharp/libvips + ImageMagick fallback. Handles all formats in-process. |
| Audio/Video Processing | nVideo (native NAPI) | Direct FFmpeg library integration. Zero process spawning, zero-copy decode, native progress. File-to-file I/O for reliability. |

**GPU Acceleration:** nVideo supports hardware acceleration via native HW device context:
- **NVENC**: NVIDIA GPUs (h264_nvenc, hevc_nvenc, h264_cuvid, hevc_cuvid)
- **VAAPI**: Intel/AMD GPUs (h264_vaapi, hevc_vaapi)
- **QSV**: Intel Quick Sync Video (h264_qsv, hevc_qsv)
- **D3D11VA**: Windows DirectX (decode only)

Configured via `config.json` (`media.gpu.platform`).

---

## 3. API Architecture

### Primary Transport (Recommended)
All new clients should use the unified transport layer:

1. **Upload** → `POST /v1/upload` (raw binary stream)
2. **Process** → `POST /v1/process` (`fileId` or `input_path`)
3. **Progress** → `GET /v1/jobs/:jobId/progress` (SSE) or `WS /v1/ws`
4. **Download** → `GET /v1/assets/:assetId`

### Legacy Endpoints
The following endpoints are retained for backward compatibility but are **deprecated** for new integrations:
- `POST /v1/process/image`
- `POST /v1/process/image/crop`
- `POST /v1/process/audio`
- `POST /v1/process/video`
- `POST /v1/audio/probe`
- Task system routes (`/v1/tasks/*`)

---

## 4. Worker Execution Modes

Processing runs in configurable modes via `workers.mode`:

**Process Mode** (`"process"` - default and recommended):
- Each task spawns a Node.js `child_process.fork`
- nVideo runs in child process, main event loop stays free
- Maximum isolation — native module panics kill only the child process
- Other workers continue processing unaffected
- Worker bootstrap: `src/tasks/TaskWorker.js`

**Thread Mode** (`"thread"`):
- Each task spawns a Node.js `worker_thread`
- nVideo runs in worker, main event loop stays free
- True parallelism bounded by `maxConcurrentTasks`
- Native module panics are isolated to the worker thread
- Worker bootstrap: `src/tasks/TaskWorker.js`

**Queue Mode** (`"queue"`):
- Tasks processed via TaskQueue → Worker → PipelineExecutor on main thread
- Serialized execution, lower memory footprint
- Not recommended for audio/video due to native module crash risk

---

## 5. Messaging Layer

### Transport Adapters

| Transport | Best For | Endpoint |
|-----------|----------|----------|
| SSE | Browser clients, simple push | `GET /v1/jobs/:jobId/progress` |
| WebSocket | Low latency, bidirectional, binary transfer | `WS /v1/ws` |
| REST Polling | Firewalls, simple clients | `GET /v1/jobs/:jobId` |

### Message Types
- `start`, `progress`, `complete`, `error`, `cancelled`

### WebSocket Capabilities
The WebSocket server (`/v1/ws`) supports:
- **Progress subscription**: `subscribe` / `unsubscribe` to job IDs
- **Binary upload**: `upload_start` → binary chunks → `upload_complete`
- **Binary download**: `download_request` → server streams file in binary frames
- **Ping/pong**: Keep-alive heartbeat

---

## 6. Asset Cache

- **Storage:** Local disk (`./cache/assets/`)
- **Default TTL:** 1 hour
- **Retrieved TTL:** 0 (immediate cleanup on next cycle)
- **Max Size:** 10GB (configurable)
- **Cleanup:** Background job every 5 minutes
- **Range Support:** Partial downloads via HTTP Range header

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
1. Node.js HTTP server → **DONE** (native `http` module + custom Router)
2. Custom multipart parser → **DONE** (retained for legacy endpoints)
3. Task system → **DONE** (Task, TaskStore, TaskQueue, Worker, TaskManager)
4. SSE messaging → **DONE** (ProgressReporter decoupled via Sender interface)
5. Asset cache → **DONE** (AssetCache class, disk storage, TTL cleanup)

### Phase 2: Image Processing ✅ COMPLETE
1. nImage integration → **DONE**
2. RAW format support → **DONE**
3. HEIC/HEIF support → **DONE**
4. 150+ format support → **DONE**
5. ESM Windows import fix → **DONE**

### Phase 3: nVideo Integration ✅ COMPLETE
1. Add nVideo submodule → **DONE**
2. Build nVideo → **DONE**
3. Rewrite AudioProcessor → **DONE**
4. Rewrite VideoProcessor → **DONE**
5. Remove FFmpeg CLI wrapper → **DONE**
6. Remove FFmpeg binary → **DONE**
7. Add worker mode config → **DONE**
8. Implement TaskWorker → **DONE**
9. Update config → **DONE**

### Phase 4: Transport Architecture Redesign ✅ COMPLETE
1. AssetCache implementation → **DONE**
2. Job Store & Persistence → **DONE**
3. Streaming upload endpoint (`POST /v1/upload`) → **DONE**
4. Unified `POST /v1/process` endpoint → **DONE**
5. Job management endpoints (`/v1/jobs/*`) → **DONE**
6. Path validation against allowlist → **DONE**
7. Thread mode default for audio/video → **DONE**

### Phase 5: WebSocket Transport ✅ COMPLETE
1. Raw WebSocket server (`src/server/WebSocketServer.js`) → **DONE**
2. WebSocket connection adapter (`WebSocketConnection` implements `Sender`) → **DONE**
3. ProgressReporter WS support → **DONE**
4. WS binary upload handling (`src/api/routes/websocket.js`) → **DONE**
5. WS binary download handling → **DONE**
6. Transport Tests UI integration (`mediaservice-web`) → **DONE**

### Phase 6: Stabilization & Fixes ✅ COMPLETE
1. Fix upload handler `end`/`close` race condition → **DONE**
2. Fix `assetId` propagation in WS progress completion → **DONE**
3. Fix ESM `require` issue in TaskWorker → **DONE**
4. Fix VideoProcessor snake_case option references → **DONE**
5. WS integration test passing (`tests/ws-integration-test.js`) → **DONE**

### Phase 7: Remaining Work 🔄 IN PROGRESS / PLANNED

#### High Priority
1. **Update E2E test suite** (`tests/e2e.test.js`)
   - Currently targets legacy multipart endpoints on port 3500
   - Should test unified transport: `/v1/upload` → `/v1/process` → `/v1/jobs/:id` → `/v1/assets/:id`
   - Update port to 3501 to match `config.json`

2. **Admin UI (`public/admin/`)**
   - Server route `/admin/*` is live but `public/` directory does not exist
   - Build a minimal dashboard: processor status, job list, asset stats, upload/process/download flow

#### Medium Priority
3. **Task retry logic**
   - Exponential backoff for failed tasks
   - Configurable max retry count

4. **Native module cancellation**
   - Abort in-flight nVideo operations
   - Currently only queued jobs can be cancelled

#### Low Priority / Future
5. **Streaming endpoints** (`/v1/process/video/stream`, `/v1/process/audio/stream`)
6. **Adaptive sync/async** based on file size heuristics
7. **Additional GPU platforms** (D3D11VA decode, Apple VideoToolbox)

---

## 9. Migration Notes

### For New Clients
- **Electron/Node.js**: Use `input_path` JSON body with `POST /v1/process`
- **Web browsers**: Use `POST /v1/upload` (raw binary) then `POST /v1/process` with `fileId`
- **Progress tracking**: Use SSE (`/v1/jobs/:jobId/progress`) or WebSocket (`/v1/ws`)

### Example: curl Upload
```bash
curl -X POST http://localhost:3501/v1/upload \
  -H "Content-Type: application/octet-stream" \
  -H "Content-Length: $(stat -c%s video.mp4)" \
  -H "X-Original-Filename: video.mp4" \
  --data-binary @video.mp4
```

---

## 10. nVideo Integration Details

### Architecture

```javascript
// modules/nVideo/lib/index.js
const nVideo = require('nvideo');

// Probe metadata
const info = nVideo.probe('input.mp4');

// Transcode with progress
nVideo.transcode('input.mkv', 'output.mp4', {
  video: { codec: 'libx264', width: 1280, height: 720, crf: 23 },
  audio: { codec: 'aac', bitrate: 128000, sampleRate: 16000, channels: 1 },
  onProgress: (p) => console.log(`${p.percent.toFixed(1)}% at ${p.speed.toFixed(1)}x`),
  onComplete: (r) => console.log(`Done in ${(r.timeMs / 1000).toFixed(1)}s`)
});

// Extract audio from video
nVideo.extractAudio('input.mp4', 'output.mp3', {
  codec: 'mp3',
  bitrate: 128000,
  onProgress: (p) => { /* ... */ }
});
```

### GPU Codec Selection

nVideo uses native HW device context for GPU acceleration:
- **CUDA** (NVENC): `av_hwdevice_ctx_create(AV_HWDEVICE_TYPE_CUDA)`
- **QSV**: `av_hwdevice_ctx_create(AV_HWDEVICE_TYPE_QSV)`
- **VAAPI**: `av_hwdevice_ctx_create(AV_HWDEVICE_TYPE_VAAPI)`
- **D3D11VA**: `av_hwdevice_ctx_create(AV_HWDEVICE_TYPE_D3D11VA)`

Configured via `config.media.gpu.platform` → mapped to `AVHWDeviceType`.

### Progress Callbacks

nVideo provides native progress callbacks (no stderr parsing):
- `percent`: 0-100 completion
- `speed`: Encoding speed multiplier
- `bitrate`: Current bitrate
- `timestamp`: Current stream position
- `eta`: Estimated time remaining
