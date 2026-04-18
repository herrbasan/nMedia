# Media Service Web UI

A web interface for testing the Media Service API. Built with [NUI](https://github.com/yourusername/nui_wc2) (Native UI) web components.

## Features

- **Image Processor** - Resize, convert, optimize images (JPEG, PNG, WebP, AVIF, GIF)
- **Audio Processor** - Convert audio formats with metadata probe
- **Video Processor** - Extract audio, keyframes, or transcode video
- **API Tests** - Automated tests for legacy processor endpoints
- **Transport Tests** - End-to-end tests for unified transport (upload → process → download)

## Quick Start

```bash
# 1. Start the Media Service (in project root)
node src/index.js

# 2. Serve this folder
cd mediaservice-web
npx serve .

# 3. Open browser to the URL shown
```

## Architecture

- **No build step** - Static HTML/JS files
- **NUI Router** - SPA routing with page fragments
- **Module scripts** - ES modules with `type="nui/page"` initialization
- **Page logic** - Each page has a dedicated JS file in `js/` (e.g., `js/image.js`)
- **API Client** - Shared client in `js/api.js` + direct API calls per page
- **NUI submodule** - Uses `modules/nui_wc2/NUI/` directly (no copy)

## Page Structure

Each processor page follows this pattern:

**HTML file** (`pages/image.html`):
```html
<header>
    <h2><nui-icon name="icon">🔊</nui-icon> Title</h2>
</header>

<section>
    <!-- Upload area with dropzone -->
</section>

<script type="nui/page">function init(element, params, nui) { app.initImagePage(element, nui)}</script>
```

**JS file** (`js/image.js`):
```js
export function initImagePage(element, nui) {
    // element = page container
    // nui = NUI API (components, utilities)
    
    const btn = element.querySelector('#my-btn');
    btn?.addEventListener('click', () => {
        // Handle click
    });
}
```

All init functions are registered in `js/app.js` on `window.app`.

## Key Components Used

- `nui-dropzone` - File drag-and-drop
- `nui-button` - With file input for upload
- `nui-tabs` - Options/Result tabs
- `nui-card` - Content containers
- `nui-select` - Dropdown options
- `nui-slider` - Quality slider
- `nui-progress` - Loading indicators
- `nui-dialog` - Processing modal
- `nui-banner` - Toast notifications

## Backend API

The Web UI expects the Media Service running on `http://localhost:3501`:

### Unified Transport (Recommended)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/v1/upload` | Stream raw binary upload |
| `POST` | `/v1/process` | Start processing from `fileId` or `input_path` |
| `GET` | `/v1/jobs/:jobId/progress` | SSE progress stream |
| `GET` | `/v1/jobs/:jobId` | Poll job status |
| `DELETE` | `/v1/jobs/:jobId` | Cancel a queued job |
| `GET` | `/v1/assets/:id` | Download asset file |
| `WS` | `/v1/ws` | WebSocket for progress + binary transfer |

### Legacy Endpoints (Still Functional)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/v1/process/image` | Process image (multipart/form-data) |
| `POST` | `/v1/process/audio` | Process audio (multipart/form-data) |
| `POST` | `/v1/process/video` | Process video (multipart/form-data) |
| `POST` | `/v1/audio/probe` | Get audio metadata |
| `GET` | `/health` | Health check |

## Testing

### API Tests (`#page=tests`)
Automated tests for legacy processor endpoints using test files from `tests/assets/`.

### Transport Tests (`#page=transport-tests`)
End-to-end tests for the unified transport layer:
- Upload workflow (file → upload → process → download)
- Path workflow (input_path → process → download)
- WebSocket E2E (binary upload/download via WebSocket)
- Progress tracking via SSE, WebSocket, or polling

## Development

### Adding a New Processor

1. Create `pages/newtype.html` with `<script type="nui/page">function init(element, params, nui) { app.initNewtypePage(element, nui)}</script>`
2. Create `js/newtype.js` with `export function initNewtypePage(element, nui) { ... }`
3. Import and register in `js/app.js`: `import { initNewtypePage } from './newtype.js';` and add to `window.app`
4. Add to navigation in `js/app.js`
5. Add route handler in `src/api/routes/newtype.js` (backend)

### NUI Documentation

Use the MCP Orchestrator tools to query NUI component documentation:

| Tool | Purpose |
|------|---------|
| `Orchestrator_nui_list_components` | List all available NUI components with categories |
| `Orchestrator_nui_get_component` | Get docs, usage guide, and code examples for a specific component |
| `Orchestrator_nui_get_guide` | Get guides (getting-started, architecture-patterns, api-structure, etc.) |
| `Orchestrator_nui_get_reference` | Compact API reference cheat sheet |
| `Orchestrator_nui_get_css_variables` | List all CSS theme variables |
| `Orchestrator_nui_get_icons` | List all available icon names for `nui-icon` |

Also see `modules/nui_wc2/Playground` for interactive component examples.

## License

Same as Media Service
