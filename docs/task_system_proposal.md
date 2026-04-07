# Task System Architecture Proposal

## Design Goals

1. **Transparent**: Apps use the service without knowing sync/async internals
2. **Flexible Retrieval**: Results accessible via HTTP, WebSocket, or future transports
3. **Performance**: Zero-copy where possible, cache-backed, minimal overhead
4. **Progress**: Real-time updates via SSE (now) + WebSocket (planned)

---

## Core Concept: "Adaptive Sync/Async"

The service decides sync vs async based on **estimated duration**, but the client can override.

```javascript
// Client request - same endpoint works for both
POST /v1/process/video
Content-Type: multipart/form-data
Prefer: respond-async          // Optional: force async
Prefer: respond-sync           // Optional: force sync

// Response depends on mode:
// SYNC (200) -> Immediate result
// ASYNC (202) -> Task ID, retrieve later
```

### Decision Logic

```javascript
function shouldUseAsync(inputSize, type, options) {
  // Client override takes precedence
  if (headers['prefer'] === 'respond-async') return true;
  if (headers['prefer'] === 'respond-sync') return false;
  
  // Auto-detect based on heuristics
  if (type === 'video') return true;                    // Video is always async
  if (type === 'audio' && inputSize > 50MB) return true; // Large audio
  if (inputSize > 100MB) return true;                    // Very large files
  
  return false;  // Default to sync for speed
}
```

---

## Result Retrieval Patterns

### Pattern 1: Immediate Sync (Images, Small Audio)

```javascript
POST /v1/process/image
→ 200 OK
→ { base64: "...", metadata: {...} }
```

### Pattern 2: Async with Polling (Simple Clients)

```javascript
// 1. Submit task
POST /v1/process/video
→ 202 Accepted
→ { taskId: "550e8400-e29b-41d4-a716-446655440000", status: "queued" }

// 2. Poll for status
GET /v1/tasks/550e8400-e29b-41d4-a716-446655440000
→ { status: "processing", progress: 45 }

// 3. Retrieve result when complete
GET /v1/tasks/550e8400-e29b-41d4-a716-446655440000/result
→ 200 OK (binary stream or JSON with base64)
```

### Pattern 3: Async with SSE Progress (Recommended)

```javascript
// 1. Submit with SSE connection
POST /v1/process/video
→ 202 Accepted
→ { 
    taskId: "550e8400-...",
    progressUrl: "/v1/tasks/550e8400-.../progress?sse=1"
  }

// 2. Connect to SSE immediately
GET /v1/tasks/550e8400-.../progress?sse=1
→ SSE stream:
   event: progress\ndata: {"percent": 10, "message": "Extracting frames"}\n\n
   event: progress\ndata: {"percent": 50, "message": "Processing..."}\n\n
   event: completed\ndata: {"assetId": "asset-...", "url": "/v1/assets/asset-..."}\n\n

// 3. Download from asset URL
GET /v1/assets/asset-...
→ 200 OK (binary stream)
```

### Pattern 4: Async with WebSocket (Future)

```javascript
// WebSocket upgrade for bidirectional
WS /v1/ws
→ Send:    {"type": "subscribe", "taskId": "550e8400-..."}
→ Receive: {"type": "progress", "percent": 50}
→ Receive: {"type": "completed", "assetId": "asset-..."}
```

---

## Cache Strategy

### Two-Tier Caching

```
┌─────────────────────────────────────────────────────────────┐
│                     Asset Cache                              │
├─────────────────────────────────────────────────────────────┤
│  Hot Cache (Memory)                                         │
│  ├── Recent results (< 5 min)                               │
│  └── Frequently accessed assets                             │
│                                                             │
│  Cold Cache (Disk)                                          │
│  ├── ./cache/assets/{asset_id}.{ext}                        │
│  └── TTL-based cleanup (default 1 hour)                     │
└─────────────────────────────────────────────────────────────┘
```

### TTL Management

| Scenario | TTL Strategy |
|----------|-------------|
| Task created | Default TTL (1 hour) |
| Progress SSE connected | Extend TTL by 10 min on each poll |
| Result retrieved | Reduce TTL to 5 min (cleanup faster) |
| Explicit delete | Immediate removal |

### Cache Key Determinism

```javascript
// Same input + same options = same task ID = cached result
const taskId = hash({
  inputHash: sha256(inputBuffer),
  type: 'video',
  options: { mode: 'extract_audio', format: 'mp3' }
});
```

---

## Implementation Architecture

### Route Handler (Unified)

```javascript
// src/api/routes/optimize.js
export async function handleOptimize(ctx) {
  const type = ctx.params.type; // image, audio, video
  const input = getInput(ctx);
  const options = getOptions(ctx);
  
  // Determine sync vs async
  const useAsync = shouldUseAsync(input.length, type, options, ctx.headers);
  
  if (useAsync) {
    // Async path
    const task = await createAndSubmitTask(type, input, options);
    
    ctx.json(202, {
      taskId: task.id,
      status: 'queued',
      progressUrl: `/v1/tasks/${task.id}/progress`,
      resultUrl: `/v1/tasks/${task.id}/result`,
      estimatedDuration: task.estimatedDuration
    });
  } else {
    // Sync path - immediate processing
    const result = await PipelineExecutor.execute(type, input, options);
    
    if (options.response_type === 'file') {
      ctx.send(200, result.buffer, result.metadata.mimeType);
    } else {
      ctx.json(200, {
        base64: result.buffer.toString('base64'),
        ...result.metadata
      });
    }
  }
}
```

### Task Lifecycle

```
[Client] → POST /v1/process/video
             ↓
[TaskManager] → Create Task → Store input in AssetCache
             ↓
[TaskQueue] → Queue task (if workers busy)
             ↓
[Worker] → Pick up task → Process with progress callbacks
             ↓
[AssetCache] → Store result
             ↓
[ProgressReporter] → SSE: {type: "completed", assetId: "..."}
             ↓
[Client] → GET /v1/assets/{assetId} → Download result
```

### Worker Implementation

```javascript
// src/tasks/Worker.js
class Worker {
  async process(task) {
    task.status = 'running';
    task.startedAt = Date.now();
    
    // Retrieve input from cache
    const inputBuffer = assetCache.getBuffer(task.inputAssetId);
    
    // Process with progress reporting
    const result = await PipelineExecutor.execute(
      task.type,
      inputBuffer,
      task.options,
      (percent, message) => {
        task.progressReporter.send(task.id, 'progress', { percent, message });
      }
    );
    
    // Store result in cache
    const resultAsset = assetCache.store(
      task.type,
      result.buffer,
      result.metadata.mimeType,
      result.metadata
    );
    
    task.resultAssetId = resultAsset.id;
    task.status = 'completed';
    task.completedAt = Date.now();
    
    // Notify completion
    task.progressReporter.send(task.id, 'completed', {
      assetId: resultAsset.id,
      url: `/v1/assets/${resultAsset.id}`
    });
    
    return result;
  }
}
```

---

## WebSocket Integration Plan

### Why Both SSE and WebSocket?

| Transport | Best For | Why |
|-----------|----------|-----|
| **SSE** | Simple clients, browsers, mobile | HTTP-compatible, auto-reconnect, firewall-friendly |
| **WebSocket** | Real-time apps, bidirectional | Lower latency, binary frames, server push |

### WebSocket Protocol Design

```javascript
// Connection
WS /v1/ws

// Client → Server messages
{ "type": "subscribe", "taskId": "550e8400-..." }
{ "type": "unsubscribe", "taskId": "550e8400-..." }
{ "type": "ping" }

// Server → Client messages
{ "type": "pong" }
{ "type": "task_created", "taskId": "...", "status": "queued" }
{ "type": "progress", "taskId": "...", "percent": 50, "message": "..." }
{ "type": "completed", "taskId": "...", "assetId": "..." }
{ "type": "error", "taskId": "...", "code": "...", "message": "..." }
```

---

## Summary

| Feature | Status | Notes |
|---------|--------|-------|
| Sync processing | ✅ Works now | Images, small audio |
| Async task system | ✅ Implemented | TaskManager, Queue, Workers |
| Asset caching | ✅ Works now | TTL-based disk cache |
| SSE progress | ✅ Works now | /v1/process/progress/:id |
| **Task-connected routes** | ⚠️ Need to wire | Connect /v1/process/* to TaskManager |
| **WebSocket transport** | ⚠️ Need to add | /v1/ws endpoint |
| **Adaptive sync/async** | ⚠️ Need to implement | Auto + Prefer header override |

---

## Recommended Next Steps

1. **Wire task system to optimize routes** - Make video/audio use async by default
2. **Add WebSocket endpoint** - Parallel transport to SSE
3. **Implement adaptive logic** - Auto-detect sync vs async
4. **Add cache size management** - Enforce max cache size
