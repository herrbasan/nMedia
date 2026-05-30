# Processing Workflows

Detailed documentation of how media files are processed through the nMedia pipeline.

## Overview

nMedia uses two native modules for processing:

| Module | Purpose | Technology |
|--------|---------|------------|
| **nImage** | Image decode, transform, encode | LibRaw, LibHeif, Sharp/libvips, ImageMagick |
| **nVideo** | Audio/Video decode, transcode, encode | FFmpeg C API (libavformat, libavcodec, libavfilter) |

## Image Processing

### Decoder Priority Chain

```
Input Buffer
     │
     ▼
Format Detection (magic bytes, ~0.5µs)
     │
     ├─ RAW format?    → LibRawDecoder  → RGB → Sharp pipeline
     ├─ HEIC/AVIF?     → LibHeifDecoder → RGB → Sharp pipeline
     ├─ Standard?      → Sharp directly
     └─ Other format?  → MagickDecoder  → RGB → Sharp pipeline
                                      │
                                      ▼
                            Sharp Transform/Encode
                                      │
                                      ▼
                                 Output Buffer
```

### Supported Input Formats

| Decoder | Library | Formats | Speed |
|---------|---------|---------|-------|
| LibRaw | libraw | CR2, NEF, ARW, ORF, RAF, RW2, DNG, PEF, SRW, RWL, CRW, MRW, NRW, ERF, 3FR, K25, KDC, MEF, MOS, MRAW, RRF, SR2, RWZ | ~400-520ms (20MP) |
| LibHeif | libheif | HEIC, HEIF, AVIF | <100ms (12MP) |
| Sharp | libvips | JPEG, PNG, WebP, TIFF, GIF, BMP, JXL, JP2 | ~50ms |
| Magick | ImageMagick CLI | PDF, SVG, PSD, AI, EXR, HDR, DOCX, XLSX, PPTX, 150+ more | 1-5s |

### Output Formats

| Format | Quality Range | Notes |
|--------|---------------|-------|
| JPEG | 1-100 | Universal compatibility |
| PNG | compressionLevel 0-9 | Lossless, larger files |
| WebP | 1-100 | Better compression than JPEG |
| AVIF | 1-100 | Best compression, limited support |
| TIFF | compression | Lossless, editing workflows |

### Processing Options

```json
{
  "max_dimension": 1024,
  "quality": 85,
  "format": "jpeg",
  "strip_exif": true
}
```

### Crop Types

**Region crop** (normalized coordinates 0-1):
```json
{ "crop": { "type": "region", "left": 0.25, "top": 0.25, "right": 0.75, "bottom": 0.75 } }
```

**Center crop** (percentage of image):
```json
{ "crop": { "type": "center", "width": 50, "height": 50 } }
```

Defaults to 50% if only `width` is provided.

**Grid crop** (extract cells):
```json
{ "crop": { "type": "grid", "cols": 3, "rows": 3, "cells": [0, 1, 2] } }
```

`cells` is an array of cell indices (0 = top-left, read left-to-right, top-to-bottom). If omitted, all cells are extracted.

### RAW Decode Quality Presets

| Quality | Algorithm | Processing | Time (20MP) | Use Case |
|---------|-----------|------------|-------------|----------|
| 0 (Draft) | Linear interpolation | No camera WB, no highlight recovery | ~630ms | Ultra-fast previews |
| 1 (Fast) | PPG demosaic | Camera WB | ~707ms | Default previews |
| 2 (Balanced) | AHD demosaic | Camera WB, clip highlights | ~1693ms | High quality |
| 3 (Best) | AHD+ demosaic | Full processing, highlight reconstruction | ~1719ms | Final export |

**Half resolution decode** (`halfSize: true`) is ~4x faster (~370ms) for all quality settings, as LibRaw uses simple interpolation instead of complex demosaic algorithms.

---

## Audio Processing

### Processing Flow

```
1. Probe input (nVideo.probe)
   ↓
2. Extract source metadata (sample rate, channels, duration, codec)
   ↓
3. Transcode (nVideo.transcode)
   ↓
   Audio filter graph:
   abuffer → aformat → asetnsamples → abuffersink
   ↓
4. Return processed audio with metadata comparison
```

### Processing Options

```json
{
  "sample_rate": 16000,
  "channels": 1,
  "format": "mp3",
  "audio_bitrate": 128000
}
```

### Supported Sample Rates

| Rate | Use Case |
|------|----------|
| 8000 | Telephony, low-bandwidth |
| 16000 | Speech-to-Text (Whisper, etc.) |
| 22050 | Medium quality audio |
| 44100 | CD quality |
| 48000 | Video/audio production |

### Audio Codecs

| Format | Codec | Bitrate | Quality | Use Case |
|--------|-------|---------|---------|----------|
| mp3 | libmp3lame | 128-320k | Good | Legacy compatibility |
| wav | pcm_s16le | ~1411k | Lossless | Uncompressed, editing |
| ogg | libvorbis | 128-256k | Good | Open source |
| m4a | aac | 128-256k | Good | Universal compatibility |
| flac | flac | Variable | Lossless | Archiving, editing |
| aac | aac | 128-256k | Good | Universal compatibility |
| opus | libopus | 96-160k | Excellent | Modern, low-latency, streaming |

---

## Video Processing

### Processing Modes

#### Extract Audio

Extracts the audio track from a video file.

```json
{ "mode": "extract_audio" }
```

**nVideo method:** `nVideo.extractAudio(input, output, opts)`

**Flow:**
1. Probe video for audio stream info
2. Extract audio stream to target format
3. Return processed audio

#### Extract Keyframes

Extracts frames at a specified FPS for LLM vision analysis.

```json
{
  "mode": "extract_keyframes",
  "fps": 1,
  "max_dimension": 1024
}
```

**nVideo method:** `nVideo.thumbnail(path, { timestamp, width })` in a loop

**Flow:**
1. Probe video for duration and video stream info
2. Calculate frame timestamps based on FPS
3. Extract each frame as RGB24 via `nVideo.thumbnail()`
4. Convert RGB24 to JPEG via nImage
5. Return array of keyframe images

#### Transcode

Full video transcode via FFmpeg CLI. All encoding parameters are passed as raw FFmpeg arguments.

```json
{
  "mode": "transcode",
  "cli_command": "-c:v libx264 -crf 23 -preset medium -c:a aac -b:a 128k"
}
```

**nVideo method:** `nVideo.transcode(input, output, { cli_command: ... })`

**Flow:**
1. Probe video for source metadata
2. Spawn FFmpeg with the provided CLI arguments
3. Stream output to disk
4. Return processed video file path

The `cli_command` value is passed directly to FFmpeg after the input file. Any valid FFmpeg arguments can be used: codec selection (`-c:v`, `-c:a`), quality (`-crf`, `-cq`), bitrate (`-b:v`, `-b:a`), filters (`-vf`, `-af`), hardware acceleration (`-hwaccel cuda`), etc. There is no structured option building or validation — the caller is responsible for constructing valid FFmpeg command lines.

**Common recipes:**

| Recipe | CLI Command |
|--------|-------------|
| H.264 Web | `-c:v libx264 -crf 23 -preset medium -c:a aac -b:a 128k` |
| H.265 Archive | `-c:v libx265 -crf 23 -preset medium -c:a aac -b:a 128k` |
| AV1 Modern | `-c:v libsvtav1 -crf 30 -preset 6 -c:a libopus -b:a 128k` |
| Copy Streams | `-c:v copy -c:a copy` |
| Audio Only (MP3) | `-vn -c:a libmp3lame -b:a 128k` |
| Audio Only (WAV) | `-vn -c:a pcm_s16le` |
| NVENC H.264 | `-hwaccel cuda -c:v h264_nvenc -preset p4 -cq 23 -c:a aac -b:a 128k` |

### Hardware Acceleration

Hardware acceleration is **only applied when explicitly requested** via `options.hwaccel`. Auto-injection of `hwaccel: 'cuda'` for NVENC codecs was removed to prevent CUDA access violation segfaults. Users must explicitly specify `-hwaccel cuda` in CLI mode or set `hwaccel` in options.

> **⚠️ Warning:** Hardware-accelerated encoding (NVENC, QSV, VAAPI) is **experimental and currently crashes** with `0xC0000005` (access violation). See `docs/handover_2026-04-22.md` for full details. **Software encoding (`libx264`, `libx265`, `libsvtav1`) is reliable and recommended.**

#### Zero-Copy GPU Acceleration Pipeline
The data-flow logic in `src/tasks/TaskWorker.js` propagates `cli_command` and `hwaccel` overrides to the underlying FFmpeg runner. In theory this enables GPU-accelerated pipelines where video frames remain in VRAM. **However, HW-accelerated encoding currently crashes** (see `docs/handover_2026-04-22.md`). Software encoding is the reliable path.

#### Disk-to-Disk Processing
When jobs output results directly to disk (via `output_path` or when the worker returns `filePath`/`outputPath` instead of a buffer), `Worker.js` forks the `assetCache` flow to ingest from `result.filePath` / `result.outputPath` instead of `result.buffer`. This prevents null reference exceptions when in-memory buffers are bypassed.

| Platform | Video Decode | Video Encode | GPU Requirement |
|----------|--------------|--------------|-----------------|
| `nvenc` | h264_cuvid, hevc_cuvid | h264_nvenc, hevc_nvenc, av1_nvenc | NVIDIA GTX 600+ |
| `qsv` | h264_qsv, hevc_qsv | h264_qsv, hevc_qsv, av1_qsv | Intel 4th Gen+ |
| `vaapi` | h264_vaapi, hevc_vaapi | h264_vaapi, hevc_vaapi | Linux + Intel/AMD GPU |
| `cpu` | software | libx264, libx265, libsvtav1 | None |

### Video Codecs

| Codec | Speed | Quality | Use Case |
|-------|-------|---------|----------|
| libx264 | Medium | Excellent | H.264/AVC, universal compatibility |
| libx265 | Slow | Superior | H.265/HEVC, better compression |
| libsvtav1 | Medium | Excellent | AV1, modern, streaming |
| libaom-av1 | Slow | Best | AV1, maximum quality |
| h264_nvenc | Very Fast | Good | NVIDIA GPU encoding |
| hevc_nvenc | Very Fast | Good | NVIDIA GPU HEVC encoding |
| av1_nvenc | Fast | Very Good | NVIDIA RTX 40-series AV1 |

---

## Worker Execution

### Process Mode (Default)

Each processing task spawns a `child_process.fork`. This provides:

- **Maximum isolation** - A crash in nVideo kills only the child process, not the main process or other workers
- **True parallelism** - Multiple files processed simultaneously
- **Memory isolation** - Each process has its own memory space

**Worker lifecycle:**
1. Main process queues task
2. Child process spawned via `child_process.fork`
3. Native module loaded via `createRequire(import.meta.url)`
4. Processing executes (nVideo.transcode, nImage pipeline, etc.)
5. Result returned to main process via IPC
6. Child process exits

### Thread Mode

Each processing task spawns a `worker_thread`. This provides:

- **True parallelism** - Multiple files processed simultaneously
- **Native panic isolation** - A crash in nVideo kills only the worker thread, not the main process
- **Memory isolation** - Each worker has its own memory space
- **Lighter weight** than process mode

**Worker lifecycle:**
1. Main process queues task
2. Worker thread spawned
3. Native module loaded via `createRequire(import.meta.url)`
4. Processing executes (nVideo.transcode, nImage pipeline, etc.)
5. Result returned to main process
6. Worker thread exits

### Queue Mode

Tasks run on the main thread, serialized by the queue.

- **Lower memory footprint** - No thread/process overhead
- **Simpler debugging** - Single thread
- **Not recommended for audio/video** - Native panics crash the entire process

---

## Progress Reporting

### Native Progress Callbacks (nVideo)

nVideo provides real-time progress during transcoding:

```javascript
{
  time: 45.2,              // Current timestamp (seconds)
  percent: 45,             // 0-100
  speed: 2.5,              // Processing speed (1.0 = realtime)
  bitrate: 5000000,        // Current output bitrate
  size: 28345678,          // Bytes written
  frames: 1356,            // Video frames encoded
  fps: 125.3,              // Current throughput (frames/sec)
  audioFrames: 723456,     // Audio samples encoded
  audioTime: 45.1,         // Audio timestamp
  estimatedDuration: 100,  // Total input duration
  estimatedSize: 63000000, // Projected final size
  eta: 22,                 // Seconds remaining
  dupFrames: 0,            // Duplicate frames
  dropFrames: 0            // Dropped frames
}
```

### Pipeline Progress Mapping

Processors map native progress to the pipeline's 0-100% scale:

| Stage | Progress Range | Description |
|-------|----------------|-------------|
| Probe | 0-10% | Extract source metadata |
| Decode | 10-30% | Decode input file |
| Transcode | 30-90% | Main processing (native progress mapped here) |
| Encode | 90-100% | Final encoding and output |

---

## Error Handling

### Common Errors

| Error | Cause | Solution |
|-------|-------|----------|
| `UNSUPPORTED_FORMAT` | Unknown input format | Check capabilities endpoint |
| `DECODE_FAILED` | Corrupt file or missing codec | Verify file integrity |
| `ENCODE_FAILED` | Invalid parameters | Check codec/format compatibility |
| `OUT_OF_MEMORY` | Image/video too large | Reduce dimensions or use tile decode |
| `MODULE_NOT_LOADED` | Native binary missing | Rebuild nImage/nVideo |

### GPU Errors

| Error | Cause | Solution |
|-------|-------|----------|
| NVENC session limit | Max concurrent GPU sessions reached | Queue processing or increase limit |
| GPU out of memory | Video too large for GPU VRAM | Use CPU encoding or reduce resolution |
| Codec not supported | GPU doesn't support codec | Fall back to CPU encoding |

---

## Media Utility Endpoints

Synchronous endpoints that bypass the task queue for immediate media inspection.

### Thumbnail Generation (`GET /v1/thumbnail/*`)

Best-effort thumbnail for any media file. Returns JPEG.

| Media Type | Method | Details |
|-----------|--------|---------|
| Image | nImage resize | Standard resize pipeline, width constrained |
| Video | nVideo.thumbnail() | Frame extracted at 1 second, RGB24 → JPEG via nImage |
| Audio | FFmpeg `-map 0:v:0` | Extracts embedded cover art, resized via nImage |

**Query parameter:** `width` (default 256)

**Error cases:**
- Audio without cover art → 415
- Unknown file type → 415

### Info Extraction (`GET /v1/info/*`)

Detailed metadata for any media file. Returns JSON.

| Media Type | Source | Fields |
|-----------|--------|--------|
| Image | nImage metadata | format, dimensions, channels, depth, density, hasAlpha, isProgressive, chromaSubsampling, hasProfile, hasExif, hasIcc, hasIptc |
| Video/Audio | nVideo.probe + ffprobe | duration, bitrate, format, tags, hasCoverArt, video/audio stream details |

**Tag normalization:** Common ID3/metadata tags (title, artist, album, genre, track, disc, date, composer, etc.) are extracted and normalized. Raw tags are included under `tags.raw`.

**Example audio response:**
```json
{
  "path": "D:/Media/song.mp3",
  "mediaType": "audio",
  "duration": 256.5,
  "bitrate": 185436,
  "format": "mp3",
  "tags": {
    "title": "My Ship",
    "artist": "André Previn",
    "album": "Alone",
    "genre": "Jazz",
    "coverArt": true,
    "raw": { "TPE1": "André Previn", "TIT2": "My Ship", ... }
  },
  "hasCoverArt": true,
  "video": null,
  "audio": { "codec": "mp3", "sampleRate": 44100, "channels": 2, "bitrate": 185345 },
  "streams": [{ "type": "audio", "codec": "mp3", "index": 0 }],
  "size": 1390770,
  "modifiedAt": "2026-05-30T08:00:00.000Z"
}
```

---

## See Also

- [README.md](README.md) - Main API documentation
- [ARCHITECTURE.md](ARCHITECTURE.md) - Architecture overview
- [CAPABILITIES.md](CAPABILITIES.md) - Capabilities endpoint reference
