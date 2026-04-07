# Media Service

A stateless Node.js microservice for optimizing images, audio, and video for LLM consumption.

## Overview

Media Service is designed as a sidecar service for the LLM Gateway. It receives large multimodal payloads (images, audio, video), aggressively compresses/downscales them, and returns LLM-friendly formats. By isolating this CPU-heavy workload, the core Gateway remains lightweight.

## Tech Stack

- **Runtime:** Node.js 18+
- **HTTP Server:** Native Node.js `http` module with custom Router
- **Image Processing:** nImage (native NAPI with libraw/libheif/ImageMagick)
- **Audio/Video Processing:** FFmpeg CLI
- **File Upload:** Custom multipart parser

## Project Structure

```
src/
├── index.js              # Application entry point
├── config/
│   └── config.js         # Configuration loader (config.json)
├── server/
│   ├── HttpServer.js     # Native HTTP server with routing
│   ├── Router.js         # Request routing
│   ├── Context.js        # Request context handling
│   ├── MultipartParser.js # File upload parsing
│   ├── Sender.js         # Response utilities
│   └── SseConnection.js  # SSE connection management
├── pipeline/
│   ├── PipelineExecutor.js   # Processor registry and execution
│   ├── Processor.js          # Base processor class
│   └── ProgressReporter.js   # SSE progress reporting
├── processors/
│   ├── image/ImageProcessor.js   # Image resize/convert/crop
│   ├── audio/AudioProcessor.js    # Audio resampling
│   └── video/VideoProcessor.js    # Video audio extraction & keyframes
├── api/routes/
│   ├── image.js   # POST /v1/process/image, /v1/process/image/crop
│   ├── audio.js   # POST /v1/process/audio
│   └── video.js   # POST /v1/process/video
├── tasks/         # Async task system (Task, TaskQueue, TaskManager, Worker)
├── cache/         # Asset caching (AssetCache.js)
└── utils/
    ├── logger.js      # Structured logging (nLogger)
    └── uuid.js        # UUID generation
```

## API Endpoints

### `GET /health`

Health check endpoint reporting processor status.

### `POST /v1/process/image`

Process/resize an image.

**Parameters:**
- `file` (multipart) or `base64` - Input image
- `max_dimension` (default: 1024) - Longest edge in pixels
- `quality` (default: 85) - Output quality 1-100
- `format` (default: jpeg) - Output format: jpeg, png, webp, avif, gif
- `strip_exif` (default: true) - Remove EXIF metadata
- `response_type` (default: base64) - Response format: base64 or file

### `POST /v1/process/image/crop`

Crop an image by region, center, or grid.

**Parameters:**
- `base64` - Input image (required)
- `crop.type` - Crop type: region, center, or grid
- `crop.left/top/right/bottom` - Normalized coordinates (0-1) for region
- `crop.widthPercent/heightPercent` - Percentage for center crop
- `crop.grid.cols/rows/cells` - Grid crop configuration

### `POST /v1/process/audio`

Process/resample audio for STT models.

**Parameters:**
- `file` (multipart) or `base64` - Input audio
- `sample_rate` (default: 16000) - Output sample rate
- `channels` (default: 1) - Output channels (1=mono, 2=stereo)
- `format` (default: mp3) - Output format: mp3, wav, ogg, m4a
- `response_type` (default: base64) - Response format

### `POST /v1/process/video`

Process video - extract audio or keyframes.

**Parameters:**
- `file` (multipart) or `base64` - Input video
- `mode` (default: extract_audio) - extract_audio or extract_keyframes
- `fps` (default: 1) - Frames per second for keyframe extraction
- `max_dimension` (default: 1024) - Max dimension for extracted frames
- `response_type` (default: base64) - Response format

### `GET /v1/process/progress/:jobId`

SSE endpoint for real-time job progress (when response_type is not base64).

## Configuration

All configuration is managed via `config.json` in the project root. Required fields will throw an error at startup if missing.

| Field | Required | Description |
|-------|----------|-------------|
| `server.port` | Yes | HTTP server port |
| `server.host` | No | Host to bind (default: 0.0.0.0) |
| `media.maxFileSizeMb` | No | Max upload size in MB |
| `media.ffmpegPath` | No | Path to FFmpeg executable |
| `media.gpu.platform` | Yes | GPU platform: `nvenc`, `vaapi`, `cpu` |
| `media.gpu.device` | No | GPU device index (default: 0) |
| `logging.level` | No | Log level: error, warn, info, debug |
| `logging.logsDir` | Yes | Directory for log files |
| `logging.sessionPrefix` | No | Log file prefix (default: ms) |
| `logging.retentionDays` | No | Days to keep logs (default: 7) |
| `cache.dir` | No | Cache directory (default: ./cache/assets) |
| `cache.ttl` | No | Asset TTL in seconds (default: 3600) |
| `cache.maxSize` | No | Max cache size in bytes (default: 10GB) |
| `workers.maxConcurrentTasks` | No | Max parallel async tasks (default: 4) |

## Quick Start

```bash
npm install
npm start
```

## Usage Example

```bash
curl -X POST http://localhost:3500/v1/process/image \
  -F "file=@photo.jpg" \
  -F "max_dimension=512" \
  -F "format=webp"
```
