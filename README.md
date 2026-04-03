# Media Service

A stateless Node.js microservice for optimizing images, audio, and video for LLM consumption.

## Overview

Media Service is designed as a sidecar service for the LLM Gateway. It receives large multimodal payloads (images, audio, video), aggressively compresses/downscales them, and returns LLM-friendly formats. By isolating this CPU-heavy workload, the core Gateway remains lightweight.

## Tech Stack

- **Runtime:** Node.js 18+
- **HTTP Framework:** Express
- **Image Processing:** Sharp (libvips)
- **Audio/Video Processing:** FFmpeg via fluent-ffmpeg
- **File Upload:** Multer

## Project Structure

```
src/
├── index.js              # Application entry point
├── config/
│   └── config.js         # Environment configuration
├── pipeline/
│   ├── PipelineExecutor.js   # Processor registry and execution
│   ├── Processor.js          # Base processor class
│   └── ProgressReporter.js   # SSE progress reporting
├── processors/
│   ├── image/ImageProcessor.js   # Image resize/convert/crop
│   ├── audio/AudioProcessor.js    # Audio resampling
│   └── video/VideoProcessor.js    # Video audio extraction & keyframes
├── api/routes/
│   ├── image.js   # POST /v1/optimize/image, /v1/optimize/image/crop
│   ├── audio.js   # POST /v1/optimize/audio
│   └── video.js   # POST /v1/optimize/video
└── utils/
    └── logger.js  # Structured logging
```

## API Endpoints

### `GET /health`

Health check endpoint reporting processor status.

### `POST /v1/optimize/image`

Optimize/resize an image.

**Parameters:**
- `file` (multipart) or `base64` - Input image
- `max_dimension` (default: 1024) - Longest edge in pixels
- `quality` (default: 85) - Output quality 1-100
- `format` (default: jpeg) - Output format: jpeg, png, webp, avif, gif
- `strip_exif` (default: true) - Remove EXIF metadata
- `response_type` (default: base64) - Response format: base64 or file

### `POST /v1/optimize/image/crop`

Crop an image by region, center, or grid.

**Parameters:**
- `base64` - Input image (required)
- `crop.type` - Crop type: region, center, or grid
- `crop.left/top/right/bottom` - Normalized coordinates (0-1) for region
- `crop.widthPercent/heightPercent` - Percentage for center crop
- `crop.grid.cols/rows/cells` - Grid crop configuration

### `POST /v1/optimize/audio`

Optimize/resample audio for STT models.

**Parameters:**
- `file` (multipart) or `base64` - Input audio
- `sample_rate` (default: 16000) - Output sample rate
- `channels` (default: 1) - Output channels (1=mono, 2=stereo)
- `format` (default: mp3) - Output format: mp3, wav, ogg, m4a
- `response_type` (default: base64) - Response format

### `POST /v1/optimize/video`

Process video - extract audio or keyframes.

**Parameters:**
- `file` (multipart) or `base64` - Input video
- `mode` (default: extract_audio) - extract_audio or extract_keyframes
- `fps` (default: 1) - Frames per second for keyframe extraction
- `max_dimension` (default: 1024) - Max dimension for extracted frames
- `response_type` (default: base64) - Response format

### `GET /v1/optimize/progress/:jobId`

SSE endpoint for real-time job progress (when response_type is not base64).

## Configuration

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3500 | Server port |
| `MAX_FILE_SIZE_MB` | 300 | Max upload size |
| `LOG_LEVEL` | info | Logging level: error, warn, info, debug |
| `FFMPEG_PATH` | auto | Custom FFmpeg path |

## Quick Start

```bash
npm install
npm start
```

## Usage Example

```bash
curl -X POST http://localhost:3500/v1/optimize/image \
  -F "file=@photo.jpg" \
  -F "max_dimension=512" \
  -F "format=webp"
```
