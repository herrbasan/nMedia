# Task System Documentation

## Overview

The Task System provides asynchronous processing capabilities for heavy media operations (audio/video processing). It enables:

- **Non-blocking operations**: Clients upload files and receive a task ID immediately
- **Progress tracking**: Real-time updates via SSE (Server-Sent Events)
- **Result caching**: Processed outputs stored with TTL-based cleanup
- **Resource management**: Configurable concurrency limits via worker pool

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Task System                           │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │ TaskManager │  │  TaskQueue  │  │      Workers        │  │
│  │             │  │             │  │                     │  │
│  │ - create    │  │ - enqueue   │  │ - process tasks     │  │
│  │ - submit    │  │ - dequeue   │  │ - progress reports  │  │
│  │ - cancel    │  │ - cancel    │  │ - cache results     │  │
│  └─────────────┘  └─────────────┘  └─────────────────────┘  │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │  TaskStore  │  │   Task      │  │   AssetCache        │  │
│  │             │  │             │  │                     │  │
│  │ - storage   │  │ - state     │  │ - store results     │  │
│  │ - cleanup   │  │ - lifecycle │  │ - TTL management    │  │
│  │ - queries   │  │ - progress  │  │ - mark retrieved    │  │
│  └─────────────┘  └─────────────┘  └─────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

## Components

### Task (`src/tasks/Task.js`)

Represents a single processing task with lifecycle management.

```javascript
{
  id: string,                    // UUID v4
  type: 'image' | 'audio' | 'video',
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled',
  input: Buffer | string,        // Input data (buffer or base64)
  options: object,               // Processing options
  progressReporter: Sender,      // SSE connection for updates
  percent: number,               // 0-100 progress
  assetId: string | null,        // Cached result asset ID
  createdAt: number,             // Unix timestamp
  startedAt: number,             // Unix timestamp
  completedAt: number,           // Unix timestamp
  error: string,                 // Error message if failed
}
```

**Methods:**
- `start()` - Mark task as running
- `updateProgress(percent, message)` - Update progress
- `complete(result)` - Mark as completed
- `fail(error)` - Mark as failed
- `cancel()` - Mark as cancelled (only if pending)
- `setAssetId(assetId)` - Link to cached result

### TaskManager (`src/tasks/TaskManager.js`)

Singleton coordinator that wires together all components.

**Methods:**
- `createTask(type, input, options, progressReporter)` - Create new task
- `submitTask(task)` - Submit to queue for processing
- `cancelTask(id)` - Cancel pending task
- `getTask(id)` - Get task by ID
- `getAllTasks()` - List all tasks
- `getStats()` - Get queue/worker statistics

### TaskQueue (`src/tasks/TaskQueue.js`)

FIFO queue with concurrency control.

**Features:**
- Configurable max concurrent tasks
- Promise-based dequeue (tasks wait for available slots)
- Cancellation support for pending tasks

### Worker (`src/tasks/Worker.js`)

Processes tasks from the queue.

**Flow:**
1. Pick up task from queue
2. Call `PipelineExecutor.execute()` with progress callback
3. Store result in AssetCache
4. Mark task as complete/failed

### TaskStore (`src/tasks/TaskStore.js`)

In-memory storage for task metadata.

**Features:**
- Task lookup by ID
- Filtering by status
- Background cleanup of old tasks (1 hour TTL)

### AssetCache (`src/cache/AssetCache.js`)

Disk-based cache for task results.

**Features:**
- TTL-based expiration (default: 1 hour)
- Retrieved mark for early cleanup
- Background cleanup every 5 minutes

## API Endpoints

### Create Task
```
POST /v1/tasks
Content-Type: application/json

{
  "type": "video",
  "input": { "source": "upload" },
  "options": { "mode": "extract_audio", "format": "mp3" }
}
```

**Response (202 Accepted):**
```json
{
  "taskId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "queued",
  "createdAt": "2026-04-06T14:23:09Z"
}
```

### Get Task Status
```
GET /v1/tasks/:taskId
```

**Response:**
```json
{
  "id": "550e8400-...",
  "type": "video",
  "status": "running",
  "percent": 45,
  "assetId": null,
  "createdAt": 1712402589000,
  "startedAt": 1712402590000,
  "completedAt": null
}
```

### Get Progress (SSE)
```
GET /v1/process/progress/:jobId
Accept: text/event-stream
```

**SSE Events:**
```
event: start
data: {"type":"video"}

event: progress
data: {"percent":30,"message":"Extracting frames"}

event: progress
data: {"percent":75,"message":"Encoding video"}

event: completed
data: {"assetId":"asset-...","metadata":{"format":"mp3"}}
```

### Get Task Result
```
GET /v1/tasks/:taskId/result
```

Returns the processed file directly (binary stream).

### Cancel Task
```
DELETE /v1/tasks/:taskId
```

Only works if task is still pending. Running tasks cannot be cancelled (FFmpeg processes can be killed via abort controller).

## Audio/Video Processing Flow

### Current Implementation

```
[Client] POST /v1/process/video (multipart upload)
              ↓
[Route]    1. Parse multipart
           2. Write input to temp file: cache/input-{uuid}.mp4
           3. Create task with input file path
              ↓
[TaskManager] Queue task
              ↓
[Worker]   1. Pick up task
           2. FFmpeg: temp input → temp output
           3. Read output file into buffer
           4. Delete input temp file
           5. Store result in AssetCache
           6. Send SSE: completed
              ↓
[Client]   GET /v1/assets/:assetId (download)
              ↓
[AssetCache] Mark as retrieved (TTL = 0)
```

### Key Design Decisions

1. **File-based I/O**: FFmpeg works with file paths, not streams
   - Input: Written to temp file before processing
   - Output: Written to temp file, then read into buffer for caching

2. **Input cleanup**: Input temp files deleted immediately after processing
   - Output remains in AssetCache with TTL

3. **Progress tracking**: Parsed from FFmpeg stderr
   - Frame count, FPS, bitrate, time, speed

4. **Retrieval optimization**: Assets marked as retrieved get TTL=0
   - Next cleanup cycle removes them
   - Reduces disk usage for retrieved results

## Configuration

```json
{
  "workers": {
    "maxConcurrentTasks": 4
  },
  "cache": {
    "dir": "./cache/assets",
    "ttl": 3600,
    "maxSize": 10737418240
  }
}
```

## Future Enhancements

### Adaptive Sync/Async

Auto-detect sync vs async based on file size:

```javascript
function shouldUseAsync(inputSize, type) {
  if (type === 'video') return true;           // Video always async
  if (type === 'audio' && inputSize > 50MB) return true;
  if (inputSize > 100MB) return true;
  return false;
}
```

Client can override with `Prefer: respond-async` or `Prefer: respond-sync` header.

### WebSocket Transport

Bidirectional communication for lower latency:

```
WS /v1/ws

Client → { "type": "subscribe", "taskId": "..." }
Server → { "type": "progress", "percent": 50 }
Server → { "type": "completed", "assetId": "..." }
```

### Cache Size Management

Enforce max cache size with LRU eviction:
- Track total cache size
- When limit reached, evict oldest unretrieved assets first
- Retrieved assets already have TTL=0, will be cleaned up soon

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Task creation fails | 400 Bad Request |
| Task not found | 404 Not Found |
| Task already running | 409 Conflict |
| Processing error | SSE: error event, task marked failed |
| FFmpeg crashes | Error caught, task failed, temp files cleaned |
| Client disconnects | Processing continues, result cached |
