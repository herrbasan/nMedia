# Processing Workflows

Detailed documentation of how media files are processed through the Media Service pipeline.

## Overview

Media Service uses two native modules for processing:

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

Full video transcode with codec and quality options.

```json
{
  "mode": "transcode",
  "output_format": "mp4",
  "video_codec": "libx264",
  "audio_codec": "aac",
  "crf": 23,
  "preset": "medium",
  "width": 1920,
  "height": 1080
}
```

**nVideo method:** `nVideo.transcode(input, output, opts)`

**Flow:**
1. Probe video for source metadata
2. Build video/audio filter graphs
3. Transcode with hardware acceleration if specified
4. Return processed video

#### CLI Passthrough

FFmpeg CLI flag passthrough for advanced encoding control. Parse CLI-style flags into structured options.

```json
{
  "mode": "cli",
  "output_format": "mp4",
  "video_codec": "h264_nvenc",
  "audio_codec": "aac",
  "preset": "medium",
  "crf": 23,
  "videoOptions": {
    "rc": "constqp",
    "qp": "21",
    "tune": "hq"
  },
  "audioOptions": {
    "b": "128000"
  }
}
```

**Supported CLI flags (parsed from `videoOptions`/`audioOptions`):**

| Flag | Maps To | Description |
|------|---------|-------------|
| `-c:v` | `video_codec` | Video codec |
| `-c:a` | `audio_codec` | Audio codec |
| `-preset` | `preset` | Encoding preset |
| `-crf` | `crf` | Quality (CPU codecs) |
| `-cq` / `-qp` | `crf` | Quality (NVENC) |
| `-b:v` | `videoOptions.b` | Video bitrate |
| `-b:a` | `audioOptions.b` | Audio bitrate |
| `-ar` | `audioOptions.ar` | Audio sample rate |
| `-ac` | `audioOptions.ac` | Audio channels |
| `-r` | `fps` | Frame rate |
| `-s` | `width`/`height` | Resolution |
| `-vf` | `filters` | Video filter graph |
| `-af` | `audioOptions.af` | Audio filter graph |
| `-pix_fmt` | `videoOptions.pix_fmt` | Pixel format |
| `-g` | `videoOptions.g` | GOP size |
| `-threads` | `videoOptions.threads` | Thread count |
| `-an` | `no_audio: true` | Disable audio |
| `-vn` | `no_video: true` | Disable video |

All other flags are passed through as-is to the encoder via `av_opt_set()`.

### Hardware Acceleration

Hardware acceleration is **only applied when explicitly requested** via `options.hwaccel`. Auto-injection of `hwaccel: 'cuda'` for NVENC codecs was removed to prevent CUDA access violation segfaults. Users must explicitly specify `-hwaccel cuda` in CLI mode or set `hwaccel` in options.

> **⚠️ Warning:** Hardware-accelerated encoding (NVENC, QSV, VAAPI) is **experimental and currently crashes** with `0xC0000005` (access violation). See `docs/handover_2026-04-22.md` for full details. **Software encoding (`libx264`, `libx265`, `libsvtav1`) is reliable and recommended.**

#### Zero-Copy GPU Acceleration Pipeline
The data-flow logic in `src/tasks/TaskWorker.js` propagates `cli_command` and `hwaccel` overrides to the underlying FFmpeg runner. In theory this enables GPU-accelerated pipelines where video frames remain in VRAM. **However, HW-accelerated encoding currently crashes** (see `docs/handover_2026-04-22.md`). Software encoding is the reliable path.

#### Disk-to-Disk Processing Exceptions
When jobs utilize hardware acceleration and pipeline their outputs directly to disk without loading into software memory Buffers, `Worker.js` accurately forks the `assetCache` flow to ingest directly from `result.filePath` / `result.outputPath` instead. This prevents `length` null reference exceptions from bubbling up whenever in-memory `result.buffer`s are bypassed.

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

### Recommended Presets

| Preset | Video | Audio | Use Case |
|--------|-------|-------|----------|
| webStreaming | libx264 | aac | Universal web playback |
| archiving | libx265 | flac | Best quality/size ratio |
| modern | libsvtav1 | libopus | Modern streaming |
| fastest | h264_nvenc | aac | GPU-accelerated encoding |

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

## See Also

- [README.md](README.md) - Main API documentation
- [ARCHITECTURE.md](ARCHITECTURE.md) - Architecture overview
- [CAPABILITIES.md](CAPABILITIES.md) - Capabilities endpoint reference
