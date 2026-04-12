# Media Service Web UI - Status Document

## Overview
A web interface for the Media Service microservice that preprocesses multimedia files for LLM consumption. Built with NUI (Native UI) web components.

## What's Implemented

### ✅ Working Features

#### Image Processor (`pages/image.html`)
- File upload via drag-and-drop or file picker
- **Processing Options:**
  - Max dimension (64-4096px)
  - Quality slider (1-100)
  - Output format (JPEG, PNG, WebP, AVIF, GIF)
  - EXIF metadata stripping toggle
- **Results:** Processed image with download, size comparison, savings %, dimensions, processing time

#### Audio Processor (`pages/audio.html`)
- File upload (any format)
- **Auto-probe:** Extracts source metadata (sample rate, channels, duration, codec)
- **Processing Options:**
  - Sample rate: "Same as source" or 8k-48k Hz
  - Channels: "Same as source", Mono, or Stereo
  - Output format (MP3, WAV, OGG, M4A)
- **Results:** Processed audio with player, source vs output comparison, processing time

#### Video Processor (`pages/video.html`)
- File upload (any format)
- **Processing Modes:**
  - Extract audio track
  - Extract keyframes (with FPS and max dimension options)
- **Results:** Audio player or frame gallery, processing time

#### Settings (`pages/settings.html`)
- Service connection test
- Supported formats reference

### Technical Implementation

**NUI Patterns Used:**
- `<script type="nui/page">` delegates to `app.initXxxPage(element, nui)`
- Page logic in dedicated JS files (`js/audio.js`, `js/image.js`, etc.)
- Scoped queries: `element.querySelector('#id')`
- `nui-file-selected` event for file uploads
- `nui-dropzone-drop` event for drag-and-drop
- `nui.components.banner.show()` for notifications
- `setLoading(true/false)` on buttons

**API Client:** Inline in each page JS file

**Backend API Endpoints:**
- `POST /v1/process/image` - Image processing
- `POST /v1/process/audio` - Audio processing (with 'source' option)
- `POST /v1/audio/probe` - Audio metadata extraction
- `POST /v1/process/video` - Video processing
- `GET /health` - Health check

## Known Issues

1. **Audio probe not working:** The backend returns 500 error. Debug logging added to `src/api/routes/audio.js`. Check server logs.

2. **Processing time:** Currently measured client-side. Backend timing would be more accurate.

3. **Video processor:** Keyframe extraction gallery display needs testing.

## File Structure
```
mediaservice-web/
├── index.html              # App shell with NUI layout
├── js/
│   ├── app.js              # Router, navigation, global handlers, page init registry
│   ├── audio.js            # Audio processor logic
│   ├── image.js            # Image processor logic
│   ├── video.js            # Video processor logic
│   └── settings.js         # Settings page logic
├── pages/
│   ├── image.html          # Image processor (markup only)
│   ├── audio.html          # Audio processor (markup only)
│   ├── video.html          # Video processor (markup only)
│   └── settings.html       # Settings page (markup only)
├── css/
│   └── app.css             # Custom styles
└── modules/nui_wc2/NUI/    # NUI library (git submodule)
```

## How to Run

1. **Start Media Service** (port 3500):
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

## Backend Changes Made

### AudioProcessor (`src/processors/audio/AudioProcessor.js`)
- Added `probe()` method using `ffprobe` CLI
- Added support for `'source'` value in sample_rate and channels options
- Returns `sourceMetadata` in processing results

### Audio Routes (`src/api/routes/audio.js`)
- Added `POST /v1/audio/probe` endpoint
- Updated `POST /v1/process/audio` to handle 'source' option
- Returns `source_metadata` in response

### Index (`src/index.js`)
- Added import for `handleAudioProbe`
- Added route `POST /v1/audio/probe`

## Next Steps / TODO

1. **Fix audio probe 500 error** - Check server logs, likely issue with file parsing
2. **Add backend processing timing** - More accurate than client-side
3. **Test video keyframe extraction** - Gallery display
4. **Add batch processing** - Multiple files at once
5. **Add copy-to-clipboard** - For base64 results
6. **Theme persistence** - Remember dark/light mode

## API Response Formats

### Image Processing
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

### Audio Processing
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
