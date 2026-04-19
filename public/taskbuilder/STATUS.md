# Media Service Web UI - Status Document

## Overview

A web interface for the Media Service microservice that preprocesses multimedia files for LLM consumption. Built with NUI (Native UI) web components.

**API Base URL:** `http://localhost:3501`

## What's Implemented

### Media Processors

#### Image Processor (`pages/image.html`)
- File upload via drag-and-drop or file picker
- **Processing Options:**
  - Max dimension (64-4096px)
  - Quality slider (1-100)
  - Output format (JPEG, PNG, WebP, AVIF, GIF)
  - EXIF metadata stripping toggle
- **Results:** Processed image with download, size comparison, savings %, dimensions, processing time
- **Endpoint:** `POST /v1/process/image` (legacy)

#### Audio Processor (`pages/audio.html`)
- File upload (any format)
- **Auto-probe:** Extracts source metadata (sample rate, channels, duration, codec)
- **Processing Options:**
  - Sample rate: "Same as source" or 8k-48k Hz
  - Channels: "Same as source", Mono, or Stereo
  - Output format (MP3, WAV, OGG, M4A)
- **Results:** Processed audio with player, source vs output comparison, processing time
- **Endpoints:** `POST /v1/audio/probe`, `POST /v1/process/audio` (legacy)

#### Video Processor (`pages/video.html`)
- File upload (any format)
- **Processing Modes:**
  - Extract audio track
  - Extract keyframes (with FPS and max dimension options)
  - Transcode (with codec, CRF, preset, and resolution options)
- **Results:** Audio player, frame gallery, or transcoded video with player
- **Endpoint:** `POST /v1/process/video` (legacy)

### Testing Pages

#### API Tests (`pages/tests.html`)
- Automated test runner for legacy processor endpoints
- Tests: Health, Image, Audio, Video
- Uses test files from `tests/assets/`
- Pass/fail summary with timing and details

#### Transport Tests (`pages/transport-tests.html`)
- End-to-end tests for unified transport
- **Workflows:**
  - Upload: POST /v1/upload → POST /v1/process → GET /v1/assets/:id
  - Path: POST /v1/process (with input_path) → GET /v1/assets/:id
  - WebSocket E2E: Binary upload/download via /v1/ws
- **Progress Tracking:** SSE, WebSocket, or HTTP polling
- **Automated Tests:**
  - upload-audio: Upload + Audio Process
  - path-audio: Path + Audio Process  
  - upload-image: Upload + Image Process
  - websocket-e2e: WebSocket binary upload → process → download

### Settings (`pages/settings.html`)
- Service connection test
- Supported formats reference

### Task Builder Pages

#### Image Tasks (`pages/image-tasks.html`)
- Upload or path-based input
- **Dynamic Options:** Format list from nImage capabilities, quality slider, max dimension
- **Crop Testing:** Region (normalized coords), center (%), grid extraction
- **Batch Tests:**
  - Format Matrix: jpeg/png/webp/avif with size comparison
  - Quality Sweep: 10/25/50/75/85/95/100 with savings %
- Preset save/load/delete (localStorage)
- Custom JSON options override

#### Audio Tasks (`pages/audio-tasks.html`)
- Upload or path-based input
- **Probe:** Shows source metadata before processing
- **Dynamic Options:** Codec list from nVideo capabilities, sample rate, channels, format
- **Batch Tests:**
  - All Formats × Sample Rates matrix (mp3/wav/ogg/m4a × 16k/44k)
- Preset save/load/delete
- Custom JSON options override

#### Video Tasks (`pages/video-tasks.html`)
- Upload or path-based input
- **Mode Tabs:** Extract Audio | Extract Keyframes | Transcode
- **Dynamic Options:** Video/audio codecs, hwaccel (NVENC/QSV/VAAPI), CRF, presets
- **Batch Tests:**
  - Run All Modes: extract_audio, keyframes, transcode
- Preset save/load/delete
- Custom FFmpeg filter input

### Shared Task Builder Features
- **`js/task-builder.js`** - Common utilities:
  - Capabilities fetching and caching
  - WebSocket connection management
  - Progress tracking (SSE, WebSocket, polling)
  - Task execution (upload → process → download)
  - Preset management (localStorage)
  - UI helpers (formatFileSize, showProgress, showResult)

## Technical Implementation

**NUI Patterns Used:**
- `<script type="nui/page">` delegates to `app.initXxxPage(element, nui)`
- Page logic in dedicated JS files (`js/audio.js`, `js/image.js`, etc.)
- Scoped queries: `element.querySelector('#id')`
- `nui-file-selected` event for file uploads
- `nui-dropzone-drop` event for drag-and-drop
- `nui.components.banner.show()` for notifications
- `setLoading(true/false)` on buttons

**API Client:** Shared client in `js/api.js` for common operations

## File Structure

```
mediaservice-web/
├── index.html              # App shell with NUI layout
├── js/
│   ├── app.js              # Router, navigation, global handlers, page init registry
│   ├── api.js              # Shared API client functions
│   ├── task-builder.js     # Shared task utilities (upload, process, progress, presets)
│   ├── audio.js            # Audio processor logic
│   ├── image.js            # Image processor logic
│   ├── video.js            # Video processor logic
│   ├── audio-tasks.js      # Audio task builder logic
│   ├── image-tasks.js      # Image task builder logic
│   ├── video-tasks.js      # Video task builder logic
│   ├── settings.js         # Settings page logic
│   ├── tests.js            # API tests page logic
│   └── transport-tests.js  # Transport tests page logic
├── pages/
│   ├── home.html           # Home/landing page
│   ├── image.html          # Image processor (markup only)
│   ├── audio.html          # Audio processor (markup only)
│   ├── video.html          # Video processor (markup only)
│   ├── image-tasks.html    # Image task builder (markup only)
│   ├── audio-tasks.html    # Audio task builder (markup only)
│   ├── video-tasks.html    # Video task builder (markup only)
│   ├── settings.html       # Settings page (markup only)
│   ├── tests.html          # API tests page (markup only)
│   └── transport-tests.html # Transport tests page (markup only)
├── css/
│   └── app.css             # Custom styles
└── modules/nui_wc2/NUI/    # NUI library (git submodule)
```

## Backend API Endpoints

### Unified Transport (Recommended)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/v1/upload` | Stream raw binary upload (Content-Length required) |
| `POST` | `/v1/process` | Start processing from `fileId` or `input_path` |
| `GET` | `/v1/jobs/:jobId/progress` | SSE progress stream |
| `GET` | `/v1/jobs/:jobId` | Poll job status |
| `DELETE` | `/v1/jobs/:jobId` | Cancel a queued job |
| `GET` | `/v1/assets/:id` | Download asset file |
| `GET` | `/v1/assets/:id/metadata` | Get asset metadata |
| `GET` | `/v1/capabilities` | Get FFmpeg codecs, filters, formats, hwaccels |
| `WS` | `/v1/ws` | WebSocket for progress + binary transfer |

### Legacy Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/v1/process/image` | Image processing (multipart/form-data) |
| `POST` | `/v1/process/audio` | Audio processing (multipart/form-data) |
| `POST` | `/v1/process/video` | Video processing (multipart/form-data) |
| `POST` | `/v1/audio/probe` | Audio metadata extraction |
| `GET` | `/health` | Health check |

## How to Run

1. **Start Media Service** (default port 3501):
   ```bash
   node src/index.js
   ```

2. **Serve Web UI** (any static server):
   ```bash
   cd mediaservice-web
   npx serve .
   # or
   npx five-server
   ```

3. **Open browser** to the served URL

## Known Issues

1. **Port Configuration:** Web UI defaults to port 3501. Ensure Media Service config matches.
2. **Video Keyframes:** Gallery display may need refinement for high frame counts.
3. **WebSocket Reconnection:** Transport tests do not auto-reconnect WebSocket on disconnect.

## Capabilities Integration

The Web UI dynamically populates codec and format options from the Media Service's nVideo and nImage capabilities:

### Endpoint: `GET /v1/capabilities`

Query parameters:
- `?module=nvideo` - nVideo capabilities only
- `?module=nimage` - nImage capabilities only
- `?section=build` - FFmpeg version, configuration, protocols, hwaccels
- `?section=codecs` - All available codecs
- `?section=common` - Curated encoder/decoder lists by hardware type
- `?section=filters` - All available filters
- `?section=formats` - All container formats
- `?section=hwaccels` - Hardware acceleration info
- No param - Full capabilities object (both nVideo and nImage)

### nVideo Capabilities

**Audio Processor:**
- Audio codec dropdown populated from `commonCodecs.encoders.audio`

**Video Processor:**
- Container formats from `formats` (filtered by mux capability)
- Video codecs from `commonCodecs.encoders.video.cpu`
- Audio codecs from `commonCodecs.encoders.audio`
- Hardware acceleration from `videoEncodersByHwaccel` (nvenc, qsv, vaapi, etc.)
- Recommended presets displayed from `commonCodecs.recommended`

### nImage Capabilities

**Image Processor:**
- Output formats from `encoders` (jpeg, png, webp, avif, tiff)
- Supported input formats displayed by decoder type (RAW, HEIC, Sharp, ImageMagick)
- Module state (isLoaded, hasSharp, version)

### Transport Tests:
- All above options available in the processing options card
- HWAccel selection affects which encoder is used (CPU vs GPU)
- Image format dropdown populated dynamically from nImage encoders

## API Response Formats

### Image Processing (Legacy)
```json
{
  "original_size_bytes": 2337022,
  "processed_size_bytes": 246567,
  "format": "jpeg",
  "width": 768,
  "height": 1024,
  "base64": "data:image/jpeg;base64,..."
}
```

### Audio Processing (Legacy)
```json
{
  "original_size_bytes": 1554321,
  "processed_size_bytes": 456789,
  "sample_rate": 16000,
  "channels": 1,
  "format": "mp3",
  "source_metadata": {
    "sampleRate": 44100,
    "channels": 2,
    "duration": 245.3,
    "codec": "aac"
  },
  "base64": "data:audio/mpeg;base64,..."
}
```

### Audio Probe
```json
{
  "success": true,
  "metadata": {
    "sampleRate": 44100,
    "channels": 2,
    "duration": 245.3,
    "codec": "aac",
    "bitrate": 128000
  }
}
```

### Unified Transport Responses

**POST /v1/upload:**
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

**POST /v1/process:**
```json
{
  "jobId": "job-def-456",
  "status": "queued",
  "queuePosition": 1
}
```

**SSE Progress:**
```
event: start
data: {"event":"start","jobId":"job-def-456","processor":"audio"}

event: progress
data: {"event":"progress","jobId":"job-def-456","percent":25,"message":"Transcoding..."}

event: complete
data: {"event":"complete","jobId":"job-def-456","assetId":"asset-ghi-789","metadata":{...}}
```

## TODO

1. Add copy-to-clipboard for base64 results
2. Theme persistence - Remember dark/light mode
3. Video keyframe gallery improvements for high frame counts
4. Add job history/management UI
5. Add filter selection UI with visual filter builder (scale, crop, fps, eq, etc.)
6. Side-by-side comparison view for batch results (image format matrix, quality sweep)
7. Export batch results as CSV/JSON
8. Add CRF sweep for video transcoding
