# Media Service - nVideo Integration Refactor Plan

## Goal

Replace the FFmpeg CLI wrapper (`src/utils/ffmpeg/`) with the nVideo native N-API module for all audio/video processing. This mirrors the nImage pattern already used for image processing.

## Why

| Aspect | FFmpeg CLI (Current) | nVideo (Target) |
|--------|---------------------|-----------------|
| Process spawning | Yes (per call) | No |
| File I/O | Temp files in/out | File-to-file in C++ |
| Progress parsing | Parse stderr | Native callback |
| Memory overhead | Moderate (buffers + temp files) | Near zero |
| GPU acceleration | CLI flags | Native HW device context |
| JS involvement | High (spawn, parse, cleanup) | None during processing |

## Scope

### What Changes

1. **Add nVideo as git submodule** → `/modules/nVideo`
2. **Rewrite `AudioProcessor`** → Use nVideo `transcode()` / `extractAudio()` / `probe()`
3. **Rewrite `VideoProcessor`** → Use nVideo `transcode()` / `thumbnail()` / `extractStream()`
4. **Remove FFmpeg CLI wrapper** → Delete `src/utils/ffmpeg/`
5. **Remove FFmpeg binary dependency** → No more `bin/ffmpeg.exe`, `bin/ffprobe.exe`
6. **Update config** → Remove `media.ffmpegPath`, keep `media.gpu.platform` (nVideo uses it natively)
7. **Update spec & dev plan** → Reflect new architecture

### What Stays the Same

- HTTP server, Router, multipart parser
- Task system (TaskManager, TaskQueue, Worker)
- Asset cache (disk storage, TTL)
- ProgressReporter (SSE)
- API endpoints (same URLs, same request/response format)
- ImageProcessor (nImage - unchanged)
- Web UI (mediaservice-web - unchanged)

## Implementation Phases

### Phase 1: Infrastructure ✅ COMPLETE

1. ✅ Add nVideo submodule: `git submodule add https://github.com/herrbasan/nVideo modules/nVideo`
2. ✅ Initialize and build nVideo: `npm run setup && npm run build` (in modules/nVideo)
3. ✅ Add nVideo import to MediaService (follow nImage ESM pattern with `createRequire`)
4. ✅ Verify nVideo loads and `probe()` works with test assets
   - 4K H.264/AAC MP4 (755MB) - probed successfully
   - WAV 44.1kHz stereo (14MB) - probed successfully

**Commit:** `8ab4129` - feat: add nVideo submodule (Phase 1 complete)

### Phase 2: AudioProcessor Rewrite 🔄 IN PROGRESS

Current: FFmpeg CLI → `spawn('ffmpeg', [...])` → parse stderr → read output file
Target: nVideo `transcode()` or `extractAudio()` → callback progress → output file

**Methods to implement:**
- `process(buffer, options)` → Use nVideo `transcode()` with temp file I/O ✅ DONE
- `probe(buffer)` → Use nVideo `probe()` directly (no ffprobe spawn) ✅ DONE
- Progress callback → Map nVideo `onProgress` to our `onProgress` interface ✅ DONE

**Key mapping:**
| Current Option | nVideo Equivalent |
|---------------|-------------------|
| `sample_rate` | `audioOpts.sampleRate` |
| `channels` | `audioOpts.channels` |
| `format` (mp3/wav/ogg/m4a) | Output file extension + codec in `audioOpts.codec` |

**Status:** AudioProcessor.js rewritten. Hit nVideo bug: `channel_layout=0x0` in abuffer filter for audio-only files (WAV/PCM). Fix needed in `modules/nVideo/src/processor.cpp`.

**Bug:** When decoder's `ch_layout.u.mask` is 0 (common for WAV files), the abuffer filter receives `channel_layout=0x0` which is invalid. Fix: derive channel layout from channel count when mask is 0.

### Phase 3: VideoProcessor Rewrite ✅ COMPLETE

Current: FFmpeg CLI → `spawn('ffmpeg', [...])` for extract_audio or extract_keyframes
Target: nVideo `extractAudio()` / `thumbnail()` / `transcode()`

**Methods to implement:**
- `extractAudio(buffer, options)` → Use nVideo `extractAudio()` ✅ DONE
- `extractKeyframes(buffer, options)` → Use nVideo `thumbnail()` in a loop at calculated timestamps ✅ DONE
- Progress callback → Map nVideo `onProgress` to our `onProgress` interface ✅ DONE

**Key mapping:**
| Current Option | nVideo Equivalent |
|---------------|-------------------|
| `mode: extract_audio` | `extractAudio()` |
| `mode: extract_keyframes` + `fps` | Loop `thumbnail()` at `timestamp = n/fps` |
| `max_dimension` | `thumbnail()` width parameter |

**Status:** VideoProcessor.js rewritten. Both modes working:
- extract_audio: 52MB MOV → 138KB MP3
- extract_keyframes: 8 frames at 640px width, RGB→JPEG via nImage

### Phase 4: Cleanup ✅ COMPLETE

1. ✅ Delete `src/utils/ffmpeg/` (index.js, parser.js, codecs.js)
2. ✅ Remove `bin/ffmpeg.exe` and `bin/ffprobe.exe` (deleted entire bin/ directory)
3. ✅ Remove `@ffmpeg-installer/ffmpeg` from `package.json` dependencies
4. ✅ Update `config.json` schema (removed `media.ffmpegPath`)
5. ✅ Update `config/config.js` validation (removed getFfmpegPath, added workersMode)
6. ✅ Delete `src/utils/HeifDecoder.js` (nImage handles HEIC natively)
7. ✅ Update health check to use nVideo probe instead of verifyFfmpeg

**Net result:** 1004 lines of FFmpeg CLI code removed

### Phase 5: Worker Mode Implementation

Add configurable execution mode for audio/video processing:

```json
{
  "workers": {
    "maxConcurrentTasks": 4,
    "mode": "queue"
  }
}
```

**Queue Mode** (default, current behavior):
- Tasks processed via TaskQueue → Worker → PipelineExecutor
- nVideo runs on main thread, serialized by queue
- Lower memory, simpler architecture
- Event loop blocked during processing (acceptable for sync endpoints)

**Thread Mode** (new):
- Each task spawns a Node.js `worker_thread`
- nVideo runs synchronously in worker, event loop stays free
- True parallelism bounded by `maxConcurrentTasks`
- Requires: worker bootstrap script, `parentPort` message passing, error propagation

**Implementation:**
1. Create `src/tasks/TaskWorker.js` - worker_thread bootstrap
2. Modify `src/tasks/Worker.js` - spawn worker_thread when mode is "thread"
3. Message protocol: `{ type: 'process', mediaType, inputPath, outputPath, options }` → `{ type: 'progress', percent, metadata }` | `{ type: 'complete', result }` | `{ type: 'error', message }`
4. Progress forwarding: worker sends progress → main thread relays to SSE

### Phase 6: Documentation

1. Update `docs/media_service_spec.md`
2. Update `docs/media_service_dev_plan.md`
3. Update `README.md`

## Risk Assessment

| Risk | Mitigation |
|------|-----------|
| nVideo build fails on Windows | MSVC v143 required, Python 3 for node-gyp |
| nVideo API changes | Pin submodule to specific commit |
| Audio codec support (OGG/Opus) | Verify nVideo `extractAudio()` supports target formats |
| Keyframe extraction performance | Loop `thumbnail()` vs `transcode()` + video filter - benchmark both |
| Progress callback threading | Solved by Thread Mode (worker_thread) |
| Worker thread message overhead | Minimal for file-to-file ops (progress updates only) |
| Native module in worker_thread | nVideo must be loadable in worker context (verify N-API compatibility) |

## File Change Summary

| File | Action |
|------|--------|
| `modules/nVideo` | **Add** (submodule) |
| `src/processors/audio/AudioProcessor.js` | **Rewrite** |
| `src/processors/video/VideoProcessor.js` | **Rewrite** |
| `src/utils/ffmpeg/index.js` | **Delete** |
| `src/utils/ffmpeg/parser.js` | **Delete** |
| `src/utils/ffmpeg/codecs.js` | **Delete** |
| `src/config/config.js` | **Modify** (remove ffmpegPath) |
| `config.json` | **Modify** (remove ffmpegPath) |
| `package.json` | **Modify** (remove @ffmpeg-installer/ffmpeg) |
| `src/tasks/TaskWorker.js` | **Add** (worker_thread bootstrap) |
| `src/tasks/Worker.js` | **Modify** (support thread mode) |
| `config.json` | **Modify** (add workers.mode) |
| `docs/media_service_spec.md` | **Update** |
| `docs/media_service_dev_plan.md` | **Update** |
| `AGENTS.md` | **Update** |
| `README.md` | **Update** |
