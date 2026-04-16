# Media Service - Transport Architecture Redesign

## Context

The current multipart upload system is fundamentally broken for large files (755MB+). The `MultipartParser` pipes the entire request to disk, then performs random-access parsing to extract boundaries. This is slow, brittle, and fails when boundary strings appear in binary data.

The Media Service will almost exclusively deal with large files. The transport layer needs to be redesigned around two core patterns that match real-world usage.

---

## Design Principles

1. **No multipart parsing** - Drop `multipart/form-data` entirely
2. **Streaming uploads** - Never buffer entire request in memory
3. **Progress is mandatory** - All processing operations must report progress
4. **Decouple upload from processing** - Upload is one operation, processing is another
5. **Path-based is first-class** - Local file processing is the primary use case for Electron/Node.js clients
6. **Security by default** - Path validation, magic byte checks, resource limits
7. **Thread mode for native processing** - Queue mode is dangerous with nVideo (native panic kills main process)

---

## Security & Resource Constraints

### Path Injection Protection (Pattern A)
- `input_path` must be validated against an **allowlist** of directories configured in `config.json`
- Pre-flight `fs.access(path, fs.constants.R_OK)` check before queuing
- UNC paths (`\\server\share`) blocked by default unless explicitly allowed
- File permissions checked before processing starts

### Upload Resource Management (Pattern B)
- `Content-Length` header **required** on uploads - enables pre-flight disk space check
- Unprocessed uploads have a **TTL of 1 hour** - cleaned up if never processed
- Upload concurrency limited by `server.maxConcurrentUploads` config
- Partial uploads cleaned up on connection abort (`req.on('close')` without `req.on('end')`)
- Disk space checked before accepting first byte

### Magic Byte Validation
- `X-Content-Type` is a client hint only - **not trusted**
- Server validates file signatures (magic bytes) after upload completes
- Mismatch between declared type and detected type returns 415
- Prevents malformed input from reaching native modules (segfault prevention)

### GPU Slot Management
- NVENC has max concurrent sessions (3-5 on consumer cards)
- Configurable `media.gpu.maxConcurrentSessions` in config
- Jobs exceeding GPU slots are queued or fall back to CPU (configurable)
- Semaphore-based slot allocation

### Worker Mode
- **Thread mode is the default** for audio/video processing
- Queue mode is deprecated for native module calls - a panic in nVideo kills the entire process
- Image processing can use either mode (nImage is safer, less complex)

---

## Pattern A: Path-Based Processing

Client provides absolute path to source file. MediaService reads directly from disk. No upload needed.

### Use Case
- Electron desktop app with local file access
- Node.js clients running on same machine
- Batch processing of local files

### Configuration

```json
{
  "media": {
    "allowedInputPaths": [
      "C:\\Users\\dave\\Media\\input",
      "/home/dave/media/input"
    ],
    "allowUncPaths": false
  }
}
```

Paths in requests must start with one of the allowed prefixes.

### API

**POST /v1/process**
```json
{
  "input_path": "C:\\Users\\dave\\Media\\input\\recording.mp4",
  "processor": "video",
  "mode": "extract_audio",
  "options": {
    "sample_rate": 16000,
    "channels": 1,
    "format": "mp3"
  }
}
```

**POST /v1/process** (image)
```json
{
  "input_path": "C:\\Users\\dave\\Media\\input\\image.CR2",
  "processor": "image",
  "options": {
    "max_dimension": 1024,
    "quality": 85,
    "format": "jpeg"
  }
}
```

**POST /v1/process** (audio)
```json
{
  "input_path": "C:\\Users\\dave\\Media\\input\\podcast.wav",
  "processor": "audio",
  "options": {
    "sample_rate": 16000,
    "channels": 1,
    "format": "mp3"
  }
}
```

### Response
All path-based requests return immediately with a `jobId`:
```json
{
  "jobId": "abc-123-def",
  "status": "queued",
  "queuePosition": 2
}
```

If the path doesn't exist or isn't readable, returns 400 immediately (pre-flight check).

### Progress (SSE)
```
GET /v1/jobs/:jobId/progress

event: start
data: {"jobId":"abc-123-def","processor":"video","mode":"extract_audio"}

event: progress
data: {"percent":25,"message":"Decoding audio stream..."}

event: progress
data: {"percent":75,"message":"Encoding mp3..."}

event: complete
data: {"assetId":"xyz-789","duration_ms":1234}
```

---

## Pattern B: Upload-to-Cache Processing

Client uploads file via raw binary stream. File is stored in cache as temp file. Processing references the uploaded file.

### Use Case
- Web browser clients (fetch API)
- Remote clients without shared filesystem
- curl/HTTP clients

### Step 1: Upload

**POST /v1/upload**
```
Content-Type: application/octet-stream
Content-Length: 755000000
X-Original-Filename: recording.mp4
X-Media-Type: video/mp4
X-Upload-Id: 550e8400-e29b-41d4-a716-446655440000

[raw binary body - streamed directly to temp file]
```

**Headers:**
| Header | Required | Description |
|--------|----------|-------------|
| `Content-Length` | Yes | Enables pre-flight disk space check |
| `X-Original-Filename` | Yes | Used for format detection (sanitized, never used as filesystem path) |
| `X-Media-Type` | No | Client hint only - validated against magic bytes server-side |
| `X-Upload-Id` | No | Idempotency key for retry-safe uploads. If same ID is sent twice, returns existing fileId. |

**Response (200):**
```json
{
  "fileId": "upload-abc-123",
  "size": 755000000,
  "detectedType": "video/mp4",
  "expiresAt": "2026-04-14T18:32:00Z",
  "status": "ready"
}
```

**Response (413 - too large):**
```json
{
  "error": "File size 755MB exceeds maximum 500MB"
}
```

**Response (507 - insufficient storage):**
```json
{
  "error": "Insufficient disk space. Required: 755MB, Available: 200MB"
}
```

**Implementation:**
- Stream `IncomingMessage` directly to temp file via `fs.createWriteStream`
- Track bytes received, reject if exceeds `Content-Length` or `maxFileSizeMb`
- On `req.on('close')` without `req.on('end')`: delete partial file
- Magic byte validation after stream completes
- `X-Upload-Id` deduplication: check if upload ID exists in store before starting

### Step 2: Process

**POST /v1/process**
```json
{
  "fileId": "upload-abc-123",
  "processor": "video",
  "mode": "extract_audio",
  "options": {
    "sample_rate": 16000,
    "channels": 1,
    "format": "mp3"
  }
}
```

**Validation:**
- `fileId` must exist and not be expired
- `processor` type should match detected file type (warning if mismatch, error if impossible)
- Returns 400 if fileId not found or expired

### Response + Progress
Same as Pattern A - returns `jobId`, progress via SSE.

---

## Job Management

### Polling Fallback (for when SSE drops)

**GET /v1/jobs/:jobId**
```json
{
  "jobId": "abc-123-def",
  "status": "processing",
  "processor": "video",
  "percent": 45,
  "message": "Encoding mp3...",
  "createdAt": "2026-04-14T17:20:00Z",
  "startedAt": "2026-04-14T17:20:01Z"
}
```

**Status values:** `queued`, `processing`, `completed`, `failed`, `cancelled`

### Job Cancellation

**DELETE /v1/jobs/:jobId**
```json
{
  "jobId": "abc-123-def",
  "status": "cancelled"
}
```

- Only works for `queued` jobs (returns 409 if already processing)
- For processing jobs: sets cancellation flag, worker checks flag between processing steps
- Native module cancellation is limited - some operations cannot be interrupted mid-frame

### Job Persistence

Jobs are persisted to disk (`./cache/jobs.json`) to survive service restarts:
- On startup: jobs in `processing` state are marked `failed` (output likely corrupt)
- Jobs in `queued` state are re-queued
- Completed jobs retain their assetId mapping

---

## Asset Retrieval

Processing results are stored in the AssetCache. Client retrieves via:

**GET /v1/assets/:assetId**
- Streams file content with correct Content-Type
- Supports `Range` header for partial downloads (video seeking)
- Marks asset as "retrieved" (TTL = 0, cleaned up next cycle)

**GET /v1/assets/:assetId/metadata**
```json
{
  "assetId": "xyz-789",
  "originalSize": 755000000,
  "optimizedSize": 5242880,
  "format": "mp3",
  "createdAt": "2026-04-14T17:20:00Z",
  "retrieved": false,
  "expiresAt": "2026-04-14T18:20:00Z"
}
```

**DELETE /v1/assets/:assetId**
- Explicit client-triggered cleanup
- Returns 200 on success, 404 if not found

---

## ID Chain

```
fileId (upload) ──► jobId (processing) ──► assetId (result)
```

All three IDs are tracked in the job store:
- `fileId` → links to temp file path, detected type, upload time
- `jobId` → links to task state, progress, worker assignment
- `assetId` → links to output file path, metadata, retrieval status

Client can trace the full chain through polling or SSE events.

---

## Implementation Phases

### Phase 1: AssetCache Implementation ✅ COMPLETE
- [x] Create `src/cache/AssetCache.js`
- [x] Disk storage with UUID-based keys
- [x] TTL management (default 1 hour, 0 after retrieval)
- [x] Background cleanup job (every 5 minutes)
- [x] Max size enforcement (LRU eviction at 10GB)
- [x] `Range` header support for partial downloads

### Phase 2: Job Store & Persistence ✅ COMPLETE
- [x] Create `src/jobs/JobStore.js`
- [x] Disk-backed job persistence (`./cache/jobs.json`)
- [x] ID chain tracking (fileId → jobId → assetId)
- [x] Startup recovery (mark processing jobs as failed, re-queue pending)
- [x] Upload TTL management (1 hour for unprocessed uploads)

### Phase 3: Streaming Upload Endpoint ✅ COMPLETE
- [x] Create `POST /v1/upload` route
- [x] Stream raw binary body to temp file via `fs.createWriteStream`
- [x] Require `Content-Length` for pre-flight disk check
- [x] Support `X-Upload-Id` for idempotent retries
- [x] Size validation during stream (track bytes, reject if exceeds limit)
- [x] Partial file cleanup on connection abort
- [x] Magic byte validation after upload completes
- [x] Upload concurrency limiter

### Phase 4: Refactor Processors ✅ COMPLETE
- [x] Update `AudioProcessor.process()` to accept `{ input_path }` or `{ fileId }`
- [x] Update `VideoProcessor.process()` to accept `{ input_path }` or `{ fileId }`
- [x] Update `ImageProcessor.process()` to accept `{ input_path }` or `{ fileId }`
- [x] Path validation against allowlist
- [x] Pre-flight `fs.access()` check for path-based inputs
- [x] Enable SSE progress for all operations

### Phase 5: Refactor Route Handlers ✅ COMPLETE
- [x] Create unified `POST /v1/process` route (handles both patterns)
- [x] Create `GET /v1/jobs/:jobId/progress` SSE endpoint
- [x] Create `GET /v1/jobs/:jobId` polling endpoint
- [x] Create `DELETE /v1/jobs/:jobId` cancellation endpoint
- [x] All process routes return `{ jobId }` immediately
- [x] Thread mode supported for audio/video

### Phase 6: Cleanup 🔄 PARTIAL
- [x] Update config schema (add `allowedInputPaths`, `maxConcurrentUploads`)
- [ ] Delete `src/server/MultipartParser.js` (retained for legacy endpoints)
- [ ] Remove multipart handling from `Context.parseBody()` (retained for legacy endpoints)
- [ ] Update test suite for new API
- [ ] Update nui_wc2 web UI for new upload flow

---

## Migration Notes

### Breaking Changes
- `multipart/form-data` uploads no longer supported
- `base64` inline payloads no longer supported
- All processing is async (returns `jobId`, progress via SSE)
- `ctx.file` removed from Context
- Queue mode deprecated for audio/video processing

### Client Migration
- **Electron/Node.js**: Switch to `input_path` JSON body with `POST /v1/process`
- **Web browsers**: Use `POST /v1/upload` (raw binary) then `POST /v1/process` with `fileId`
- **curl**: `curl -X POST -H "Content-Length: $(stat -c%s video.mp4)" -H "X-Original-Filename: video.mp4" --data-binary @video.mp4 http://localhost:3500/v1/upload`

---

## Error Handling

| HTTP Status | Meaning | Response |
|-------------|---------|----------|
| 200 | Upload/Job accepted | `{ "jobId": "..." }` or `{ "fileId": "..." }` |
| 400 | Invalid request body | `{ "error": "..." }` |
| 404 | Job/Asset not found | `{ "error": "..." }` |
| 409 | Job cannot be cancelled (already processing) | `{ "error": "..." }` |
| 413 | File too large | `{ "error": "..." }` (during upload stream) |
| 415 | Unsupported format / type mismatch | `{ "error": "..." }` |
| 507 | Insufficient disk space | `{ "error": "..." }` |
| 500 | Processing error | SSE `error` event or polling `failed` status |

### SSE Error Event
```
event: error
data: {"jobId":"abc-123-def","code":"PROCESSING_ERROR","message":"nVideo: codec not supported","retryable":false}
```
