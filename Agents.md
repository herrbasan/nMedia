# Media Service - Agent Overview

## Purpose

Media Service is a stateless microservice designed to preprocess multimedia files for Large Language Model (LLM) consumption. It acts as an optimization sidecar service that receives large files and returns downscaled, compressed, LLM-friendly versions. Utilizes GPU acceleration when available (NVENC, VAAPI, QSV).

## Documentation

| Document | Location | Purpose |
|----------|----------|---------|
| Configuration | `config.json` | All configuration settings (server, media, logging, cache, workers) |
| Specification | `docs/media_service_spec.md` | Detailed technical specification, API design, architecture |
| Development Plan | `docs/media_service_dev_plan.md` | Implementation roadmap, technology choices, development phases |
| Task System | `docs/task_system_proposal.md` | Task system architecture and async patterns |

## Configuration

All configuration is managed via `config.json` in the project root. No `.env` defaults are used. The config loader throws on missing required values - this is intentional.

Required fields:
- `server.port`
- `logging.logsDir`
- `media.gpu.platform`

## Logging

Logs are stored in `/logs` (configurable via `config.json`). nLogger creates:
- **Session logs**: `{timestamp}-{sessionPrefix}-{randomId}.log` - detailed logs for each session
- **Main logs**: `main-{n}.log` - rolling logs combining all sessions (JSON Lines format)

**Primary location for recent logs:** `/logs`

## Testing

Test assets are located in `/tests/assets/`:

| Directory | Contents |
|-----------|----------|
| `tests/assets/images/` | PNG, JPG, HEIC, CR2 (Canon RAW), ORF (Olympus RAW), GIF |
| `tests/assets/audio/` | MP3, M4A, WAV, FLAC, OGG |
| `tests/assets/videos/` | MP4, MOV |

## Core Development Maxims
- **Priorities:** Reliability > Performance > Everything else.
- **LLM-Native Codebase:** Code readability and structure for *humans* is a non-goal. The code will not be maintained by humans. Optimize for the most efficient structure an LLM can understand. Do not rely on conventional human coding habits.
- **Vanilla JS:** No TypeScript anywhere. Code must stay as close to the bare platform as possible for easy optimization and debugging. `.d.ts` files are generated strictly for LLM/editor context, not used at runtime.
- **Zero Dependencies:** If we can build it ourselves using raw standard libraries, we build it. Avoid external third-party packages. Evaluate per-case if a dependency is truly necessary.
- **Fail Fast, Always:** No defensive coding. No mock data. No fallback defaults. No silencing `try/catch`. No optional chaining (`?.`) for required values. Configuration must be explicit - missing required config must throw immediately at startup. When something breaks, let it crash and fix the root cause.

## Service Management
- **Do Not Start/Restart Service:** Never start, restart, or stop the Media Service on your own. If the service needs to be started or restarted, ask the user to do it.

## Development Environment
- **FiveServer Live Reload:** The health check endpoint (`/health`) writes to `/logs` on every call. FiveServer's file watcher detects these log writes and triggers constant page reloads. This is resolved by `fiveserver.config.cjs` which ignores `/logs/` and `/cache/` directories. If live reload loops occur, verify the config exists and restart FiveServer.

## Bundled Submodules

This project uses git submodules located in `/modules`. These are all **our own projects** and can be enhanced if needed:

| Submodule | Purpose |
|-----------|---------|
| `modules/nLogger` | Structured logging |
| `modules/nImage` | Native image processing (RAW, HEIC, 150+ formats) |
| `modules/ffmpeg-napi-interface` | FFmpeg NAPI bindings for audio/video (future) |
| `modules/nui_wc2` | Web UI for monitoring/testing |

**Important:** Before modifying any submodule code, ask the user for permission. Changes to submodules affect other projects that depend on them.

## Architecture

### Components

#### PipelineExecutor (`src/pipeline/PipelineExecutor.js`)
- Singleton registry for media processors
- Routes processing requests to the appropriate processor
- Coordinates progress reporting

#### Processors (extending `src/pipeline/Processor.js`)

| Processor | Technology | Capabilities |
|-----------|------------|--------------|
| ImageProcessor | nImage (native NAPI) | Resize, format conversion, cropping (region/center/grid), EXIF stripping. Supports RAW, HEIC, and 150+ formats |
| AudioProcessor | FFmpeg CLI | Resampling (8-48kHz), channel conversion, format conversion (mp3/wav/ogg/m4a) |
| VideoProcessor | FFmpeg CLI | Audio extraction, keyframe extraction at configurable FPS |

#### FFmpeg CLI Wrapper (`src/utils/ffmpeg/`)
- Custom wrapper around FFmpeg CLI (replaced fluent-ffmpeg)
- File-based I/O for reliability (temp files in cache dir)
- Automatic GPU codec selection based on `config.media.gpu.platform`
- Real-time progress parsing from FFmpeg stderr
- Process cancellation via AbortController

**Structure:**
```
src/utils/ffmpeg/
├── index.js     # Main API: run(), abort support
├── parser.js    # Progress parsing from stderr
└── codecs.js    # GPU platform codec mappings
```

**GPU Platforms:**
| Platform | Video Decode | Video Encode |
|----------|--------------|--------------|
| `nvenc` | h264_cuvid, hevc_cuvid | h264_nvenc, hevc_nvenc |
| `vaapi` | h264_vaapi, hevc_vaapi | h264_vaapi, hevc_vaapi |
| `qsv` | h264_qsv, hevc_qsv | h264_qsv, hevc_qsv |
| `cpu` | software | libx264, libx265 |

#### ProgressReporter (`src/pipeline/ProgressReporter.js`)
- Manages Server-Sent Events (SSE) connections for real-time progress
- Provides job lifecycle events: start, progress, complete, error

#### API Routes (`src/api/routes/`)
- Native HTTP routes for `/v1/process/image`, `/v1/process/audio`, `/v1/process/video`
- Accept file uploads (multipart/form-data via custom parser) or inline base64
- Support two response modes: base64 (synchronous JSON) or file (streaming)

### Key Processing Options

**Images:**
- `max_dimension`: Longest edge constraint (default 1024px)
- `quality`: Output quality 1-100 (default 85)
- `format`: jpeg/png/webp/avif/gif
- `crop`: region (normalized coords), center (% of image), grid (cell extraction)

**Audio:**
- `sample_rate`: 8000/16000/22050/44100/48000 Hz (default 16000 for STT)
- `channels`: 1 (mono) or 2 (stereo), default mono
- `format`: mp3/wav/ogg/m4a

**Video:**
- `mode`: extract_audio or extract_keyframes
- `fps`: Frame rate for keyframe extraction (1-30)
- `max_dimension`: Max frame dimension

## Task System

The task system handles asynchronous processing:

- **TaskManager** (`src/tasks/TaskManager.js`) - Singleton coordinator
- **TaskQueue** (`src/tasks/TaskQueue.js`) - FIFO queue with concurrency control
- **Worker** (`src/tasks/Worker.js`) - Processes tasks via PipelineExecutor
- **AssetCache** (`src/cache/AssetCache.js`) - Stores results with TTL

### Audio/Video Processing Flow

```
1. Client uploads file
2. Input written to temp file in cache dir
3. FFmpeg processes: input → output
4. Output stored in AssetCache
5. Input temp file deleted
6. SSE progress updates sent
7. Client downloads result from /v1/assets/:id
8. Asset marked as retrieved (TTL = 0)
```

## Data Flow

1. Client sends file or base64 payload to `/v1/process/{media_type}`
2. Route handler validates input and extracts buffer
3. Custom multipart parser handles upload limits
4. PipelineExecutor routes to appropriate processor
5. Processor performs transformation with progress callbacks
6. Result buffer/metadata returned via JSON (base64) or streaming (file)
7. Response includes original vs optimized size for cost tracking

## Error Handling Contract

| HTTP Status | Meaning | Gateway Action |
|-------------|---------|----------------|
| 200 | Success | Swap payload |
| 413 | File too large | Return error to client |
| 415 | Unsupported format | Pass-through original |
| 5XX | Processing error | Circuit breaker trips, bypass MPS |

## LLM Integration Notes

- Images are downscaled to reduce token count while preserving visual fidelity
- Audio is resampled to 16kHz mono (optimal for Whisper/STT models)
- Video processing extracts either audio track or keyframes for analysis
- EXIF stripping removes potentially sensitive metadata
- All output formats are widely supported by LLM vision/audio models
