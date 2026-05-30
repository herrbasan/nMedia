# Capabilities Endpoint

Query runtime capabilities from the Media Service. This includes the service's HTTP API surface, processing features, configuration, and native module capabilities (nVideo and nImage). Clients use this to discover available endpoints, codecs, formats, filters, and hardware acceleration at runtime.

## Endpoint

```
GET /v1/capabilities
```

## Query Parameters

| Parameter | Values | Description |
|-----------|--------|-------------|
| `module` | `nvideo`, `nimage`, `service` | Filter to specific module. Omit for all. |
| `section` | See below | Filter to specific capability section |

## Service Capabilities

### Sections

| Section | Description |
|---------|-------------|
| `endpoints` | All HTTP and WebSocket endpoints |
| `features` | Processing features, utilities, transports, worker modes |

### Full Service Response (`?module=service`)

```json
{
  "success": true,
  "data": {
    "version": "1.0.0",
    "endpoints": [
      { "method": "GET", "path": "/health", "description": "Health check with processor readiness" },
      { "method": "POST", "path": "/v1/upload", "description": "Stream raw binary upload. Returns fileId" },
      { "method": "POST", "path": "/v1/process", "description": "Start processing from fileId or input_path. Returns jobId" },
      { "method": "GET", "path": "/v1/jobs", "description": "List all jobs" },
      { "method": "GET", "path": "/v1/jobs/active", "description": "List active (queued/processing) jobs" },
      { "method": "GET", "path": "/v1/jobs/:jobId", "description": "Get job status and progress" },
      { "method": "GET", "path": "/v1/jobs/:jobId/progress", "description": "SSE progress stream" },
      { "method": "DELETE", "path": "/v1/jobs/:jobId", "description": "Cancel a queued or processing job" },
      { "method": "GET", "path": "/v1/assets", "description": "List cached assets" },
      { "method": "GET", "path": "/v1/assets/:id", "description": "Download asset file" },
      { "method": "GET", "path": "/v1/assets/:id/metadata", "description": "Get asset metadata" },
      { "method": "DELETE", "path": "/v1/assets/:id", "description": "Delete specific asset" },
      { "method": "DELETE", "path": "/v1/assets", "description": "Clear all assets" },
      { "method": "GET", "path": "/v1/thumbnail/*", "description": "Best-effort thumbnail for any media file" },
      { "method": "GET", "path": "/v1/info/*", "description": "Detailed metadata for any media file" },
      { "method": "GET", "path": "/v1/capabilities", "description": "Query service and native module capabilities" },
      { "method": "WS", "path": "/v1/ws", "description": "WebSocket for progress, binary upload, and binary download" }
    ],
    "features": {
      "processors": [
        { "name": "image", "operations": ["resize", "crop", "format conversion", "EXIF stripping", "rotate", "flip", "flop", "grayscale", "normalize", "blur"], "formats": ["jpeg", "png", "webp", "avif", "gif", "tiff"] },
        { "name": "audio", "operations": ["transcode", "resample", "channel conversion"], "formats": ["mp3", "wav", "ogg", "m4a", "flac", "aac", "opus"] },
        { "name": "video", "operations": ["extract_audio", "extract_keyframes", "transcode", "cli_passthrough"], "formats": ["mp4", "webm", "mkv", "mov", "mp3", "wav", "ogg", "m4a", "flac", "aac", "opus"] }
      ],
      "utilities": [
        { "name": "thumbnail", "description": "Best-effort thumbnail generation for images, videos, and audio with cover art", "synchronous": true },
        { "name": "info", "description": "Detailed metadata extraction (EXIF, probe, tags, streams)", "synchronous": true }
      ],
      "transports": ["http", "sse", "websocket"],
      "workerModes": ["queue", "thread", "process"]
    },
    "config": {
      "maxFileSizeMb": 512,
      "maxFileSizeBytes": 536870912,
      "gpuPlatform": "cpu",
      "workersMode": "process",
      "maxConcurrentTasks": 4,
      "maxConcurrentUploads": 4,
      "cacheTtl": 3600,
      "cacheMaxSize": 10737418240,
      "messageTransport": "sse",
      "allowedInputPaths": ["D:/Media"],
      "allowedOutputPaths": [],
      "allowUncPaths": false
    }
  }
}
```

### Endpoints (`?module=service&section=endpoints`)

```json
{
  "success": true,
  "data": [
    { "method": "GET", "path": "/health", "description": "Health check with processor readiness" },
    { "method": "POST", "path": "/v1/upload", "description": "Stream raw binary upload. Returns fileId" },
    ...
  ]
}
```

### Features (`?module=service&section=features`)

```json
{
  "success": true,
  "data": {
    "processors": [...],
    "utilities": [...],
    "transports": ["http", "sse", "websocket"],
    "workerModes": ["queue", "thread", "process"]
  }
}
```

---

## nVideo Capabilities

## nVideo Capabilities

### Sections

| Section | Description |
|---------|-------------|
| `build` | FFmpeg version, configuration, protocols, hwaccels |
| `codecs` | All available codecs (786+) |
| `common` | Curated encoder/decoder lists by hardware type |
| `filters` | All available filters (568+) |
| `formats` | All container formats (416+) |
| `hwaccels` | Hardware acceleration info with recommended presets |

### Build Info (`?module=nvideo&section=build`)

```json
{
  "success": true,
  "data": {
    "version": "7.1-full_build-www.gyan.dev",
    "configuration": "--enable-gpl --enable-version3 --enable-libx264 ...",
    "hwaccels": ["cuda", "nvenc", "qsv", "vaapi", "d3d11va", "d3d12va", "vulkan", "amf"],
    "protocols": ["file", "http", "https", "ftp", "rtmp", "rtp", "srt", "tcp", "udp"]
  }
}
```

### Common Codecs (`?module=nvideo&section=common`)

```json
{
  "success": true,
  "data": {
    "encoders": {
      "video": {
        "cpu": ["libx264", "libx265", "libsvtav1", "libaom-av1"],
        "nvidia": ["h264_nvenc", "hevc_nvenc", "av1_nvenc"],
        "intel": ["h264_qsv", "hevc_qsv", "av1_qsv"],
        "amd": ["h264_amf", "hevc_amf", "av1_amf"],
        "other_hw": ["h264_vaapi", "hevc_vaapi", "hevc_vulkan"],
        "professional": ["prores", "prores_ks", "dnxhd", "ffv1"]
      },
      "audio": ["aac", "flac", "libmp3lame", "libopus", "ac3", "eac3", "vorbis", "pcm_s16le"]
    },
    "decoders": {
      "video": ["h264", "hevc", "av1", "libdav1d", "vp9", "vp8", "mpeg4", "mpeg2video"],
      "audio": ["aac", "mp3", "flac", "opus", "vorbis", "ac3", "eac3", "pcm_s16le"]
    },
    "videoEncodersByHwaccel": {
      "cpu": ["libx264", "libx265", "libsvtav1"],
      "nvidia": ["h264_nvenc", "hevc_nvenc", "av1_nvenc"],
      "qsv": ["h264_qsv", "hevc_qsv", "av1_qsv"],
      "vaapi": ["h264_vaapi", "hevc_vaapi"],
      "amf": ["h264_amf", "hevc_amf", "av1_amf"]
    },
    "recommended": {
      "webStreaming": { "video": "libx264", "audio": "aac" },
      "archiving": { "video": "libx265", "audio": "flac" },
      "modern": { "video": "libsvtav1", "audio": "libopus" },
      "fastest": { "video": "h264_nvenc", "audio": "aac" }
    }
  }
}
```

### Hardware Acceleration (`?module=nvideo&section=hwaccels`)

```json
{
  "success": true,
  "data": {
    "hwaccels": ["cuda", "nvenc", "qsv", "vaapi", "d3d11va", "d3d12va", "vulkan", "amf"],
    "videoEncodersByHwaccel": {
      "cpu": ["libx264", "libx265", "libsvtav1"],
      "nvidia": ["h264_nvenc", "hevc_nvenc", "av1_nvenc"],
      "qsv": ["h264_qsv", "hevc_qsv", "av1_qsv"]
    },
    "recommended": {
      "webStreaming": { "video": "libx264", "audio": "aac" },
      "archiving": { "video": "libx265", "audio": "flac" },
      "modern": { "video": "libsvtav1", "audio": "libopus" },
      "fastest": { "video": "h264_nvenc", "audio": "aac" }
    }
  }
}
```

### Filters (`?module=nvideo&section=filters`)

```json
{
  "success": true,
  "data": [
    { "name": "scale", "description": "Scale the input video size", "type": "video" },
    { "name": "crop", "description": "Crop the input video", "type": "video" },
    { "name": "fps", "description": "Convert the video to a constant frame rate", "type": "video" },
    { "name": "format", "description": "Convert the input video to a specific pixel format", "type": "video" },
    { "name": "volume", "description": "Change the input audio volume", "type": "audio" },
    { "name": "aresample", "description": "Resample audio data", "type": "audio" },
    { "name": "amix", "description": "Mix multiple audio streams", "type": "audio" }
  ]
}
```

### Formats (`?module=nvideo&section=formats`)

```json
{
  "success": true,
  "data": [
    { "name": "mov,mp4,m4a,3gp,3g2,mj2", "extensions": ["mp4", "m4a", "mov"], "canMux": true, "canDemux": true },
    { "name": "matroska,webm", "extensions": ["mkv", "webm"], "canMux": true, "canDemux": true },
    { "name": "avi", "extensions": ["avi"], "canMux": true, "canDemux": true },
    { "name": "mp3", "extensions": ["mp3"], "canMux": true, "canDemux": true },
    { "name": "wav", "extensions": ["wav"], "canMux": true, "canDemux": true }
  ]
}
```

---

## nImage Capabilities

### Sections

| Section | Description |
|---------|-------------|
| `formats` | All supported input formats |
| `state` | Module load state (isLoaded, hasSharp, version) |
| `raw` | RAW format list (LibRaw) |
| `heic` | HEIC/AVIF format list (LibHeif) |
| `imagemagick` | ImageMagick fallback format list |

### Full Capabilities (`?module=nimage`)

```json
{
  "success": true,
  "data": {
    "version": { "major": 0, "minor": 1, "patch": 0 },
    "decoders": {
      "raw": {
        "library": "libraw",
        "formats": ["cr2", "nef", "arw", "orf", "raf", "rw2", "dng", "pef", "srw", "rwl", "crw", "mrw", "nrw", "erf", "3fr", "k25", "kdc", "mef", "mos", "mraw", "rrf", "sr2", "rwz"],
        "features": ["halfSize", "qualityPresets", "thumbnails", "metadata", "streaming"]
      },
      "heic": {
        "library": "libheif",
        "formats": ["heic", "heif", "avif"],
        "features": ["thumbnails", "metadata", "alphaChannel"],
        "threading": true
      },
      "sharp": {
        "library": "sharp/libvips",
        "formats": ["jpeg", "png", "webp", "tiff", "gif", "bmp", "jxl", "jp2"],
        "features": ["resize", "crop", "rotate", "flip", "flop", "grayscale", "composite"]
      },
      "magick": {
        "library": "imagemagick",
        "formats": ["psd", "pdf", "svg", "exr", "hdr", "docx", "xlsx", "pptx", "ai", "eps", "xps"],
        "features": ["150+ formats"],
        "note": "CLI fallback, slower"
      }
    },
    "encoders": ["jpeg", "png", "webp", "avif", "tiff"],
    "state": {
      "isLoaded": true,
      "hasSharp": true,
      "version": { "major": 0, "minor": 1, "patch": 0 }
    },
    "supportedFormats": ["cr2", "nef", "arw", "heic", "jpeg", "png", "webp", ...],
    "rawFormats": ["cr2", "nef", "arw", ...],
    "heicFormats": ["heic", "heif", "avif"],
    "imagemagickFormats": ["psd", "pdf", "svg", ...]
  }
}
```

### Module State (`?module=nimage&section=state`)

```json
{
  "success": true,
  "data": {
    "isLoaded": true,
    "hasSharp": true,
    "version": { "major": 0, "minor": 1, "patch": 0 }
  }
}
```

---

## Combined Response (No Module Filter)

When no `module` parameter is specified, both nVideo and nImage capabilities are returned:

```json
{
  "success": true,
  "data": {
    "nVideo": { ... },
    "nImage": { ... },
    "nImageState": { ... }
  }
}
```

---

## Usage Examples

### Discover Available Video Codecs

```javascript
const { data } = await fetch('/v1/capabilities?module=nvideo&section=common').then(r => r.json());
const cpuEncoders = data.commonCodecs.encoders.video.cpu;
console.log('CPU encoders:', cpuEncoders);
// ['libx264', 'libx265', 'libsvtav1', 'libaom-av1']
```

### Check Hardware Acceleration Support

```javascript
const { data } = await fetch('/v1/capabilities?module=nvideo&section=hwaccels').then(r => r.json());
const hasNvenc = data.hwaccels.includes('nvenc');
console.log('NVENC available:', hasNvenc);
```

### Get Supported Image Formats

```javascript
const { data } = await fetch('/v1/capabilities?module=nimage&section=formats').then(r => r.json());
console.log('Supported formats:', data);
// ['cr2', 'nef', 'heic', 'jpeg', 'png', 'webp', ...]
```

### Check Module Load State

```javascript
const { data } = await fetch('/v1/capabilities?module=nimage&section=state').then(r => r.json());
if (!data.isLoaded) {
  console.warn('nImage native module not loaded');
}
if (!data.hasSharp) {
  console.warn('Sharp not available, transforms limited');
}
```

---

## Performance

| Method | Speed | Use Case |
|--------|-------|----------|
| Direct JSON import (nVideo) | Fastest | Build-time decisions |
| `getCapabilities()` | Fast | Runtime reference |
| Live query (`getCodecs()`, etc.) | Moderate | Dynamic checks, runtime validation |

The capabilities endpoint uses pre-generated JSON files for fast responses. Live queries to the FFmpeg binary are only needed for dynamic validation.

---

## Combined Response (No Module Filter)

When no `module` parameter is specified, service, nVideo, and nImage capabilities are all returned:

```json
{
  "success": true,
  "data": {
    "service": { ... },
    "nVideo": { ... },
    "nImage": { ... },
    "nImageState": { ... }
  }
}
```

---

## See Also

- [nVideo CAPABILITIES.md](../modules/nVideo/documentation/CAPABILITIES.md) - Full nVideo capabilities reference
- [nImage CAPABILITIES.md](../modules/nImage/documentation/CAPABILITIES.md) - Full nImage capabilities reference
