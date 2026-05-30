import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import config from '../../config/config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const nVideoPath = path.join(__dirname, '../../../modules/nVideo/lib/index.js');
const nImagePath = path.join(__dirname, '../../../modules/nImage/lib/index.js');
const require = createRequire(import.meta.url);
const nVideo = require(nVideoPath);
const nImage = require(nImagePath);

const SERVICE_ENDPOINTS = [
  { method: 'GET', path: '/health', description: 'Health check with processor readiness' },
  { method: 'POST', path: '/v1/upload', description: 'Stream raw binary upload. Returns fileId' },
  { method: 'POST', path: '/v1/process', description: 'Start processing from fileId or input_path. Returns jobId' },
  { method: 'GET', path: '/v1/jobs', description: 'List all jobs' },
  { method: 'GET', path: '/v1/jobs/active', description: 'List active (queued/processing) jobs' },
  { method: 'GET', path: '/v1/jobs/:jobId', description: 'Get job status and progress' },
  { method: 'GET', path: '/v1/jobs/:jobId/progress', description: 'SSE progress stream' },
  { method: 'DELETE', path: '/v1/jobs/:jobId', description: 'Cancel a queued or processing job' },
  { method: 'GET', path: '/v1/assets', description: 'List cached assets' },
  { method: 'GET', path: '/v1/assets/:id', description: 'Download asset file' },
  { method: 'GET', path: '/v1/assets/:id/metadata', description: 'Get asset metadata' },
  { method: 'DELETE', path: '/v1/assets/:id', description: 'Delete specific asset' },
  { method: 'DELETE', path: '/v1/assets', description: 'Clear all assets' },
  { method: 'GET', path: '/v1/thumbnail/*', description: 'Best-effort thumbnail for any media file' },
  { method: 'GET', path: '/v1/info/*', description: 'Detailed metadata for any media file' },
  { method: 'GET', path: '/v1/capabilities', description: 'Query service and native module capabilities' },
  { method: 'WS', path: '/v1/ws', description: 'WebSocket for progress, binary upload, and binary download' },
];

const SERVICE_FEATURES = {
  processors: [
    { name: 'image', operations: ['resize', 'crop', 'format conversion', 'EXIF stripping', 'rotate', 'flip', 'flop', 'grayscale', 'normalize', 'blur'], formats: ['jpeg', 'png', 'webp', 'avif', 'gif', 'tiff'] },
    { name: 'audio', operations: ['transcode', 'resample', 'channel conversion'], formats: ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac', 'opus'] },
    { name: 'video', operations: ['extract_audio', 'extract_keyframes', 'transcode', 'cli_passthrough'], formats: ['mp4', 'webm', 'mkv', 'mov', 'mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac', 'opus'] },
  ],
  utilities: [
    { name: 'thumbnail', description: 'Best-effort thumbnail generation for images, videos, and audio with cover art', synchronous: true },
    { name: 'info', description: 'Detailed metadata extraction (EXIF, probe, tags, streams)', synchronous: true },
  ],
  transports: ['http', 'sse', 'websocket'],
  workerModes: ['queue', 'thread', 'process'],
};

export async function handleCapabilities(ctx) {
  const { searchParams } = new URL(ctx.rawRequest.url, `http://${ctx.rawRequest.headers.host}`);
  const section = searchParams.get('section');
  const module = searchParams.get('module');

  try {
    if (module === 'nimage' || (!module && section === 'image')) {
      return handleImageCapabilities(ctx, section);
    }
    if (module === 'nvideo' || (!module && ['build', 'codecs', 'common', 'filters', 'hwaccels'].includes(section))) {
      return handleVideoCapabilities(ctx, section);
    }
    if (module === 'service' || (!module && section === 'endpoints')) {
      return handleServiceCapabilities(ctx, section);
    }
    if (module === 'service' || (!module && section === 'features')) {
      return handleServiceCapabilities(ctx, section);
    }
    const caps = {
      service: buildServiceCapabilities(),
      nVideo: nVideo.getCapabilities(),
      nImage: nImage.getCapabilities(),
      nImageState: {
        isLoaded: nImage.isLoaded,
        hasSharp: nImage.hasSharp,
        version: nImage.version,
        supportedFormats: nImage.getSupportedFormats(),
        rawFormats: nImage.RAW_FORMATS,
        heicFormats: nImage.HEIC_FORMATS,
        imagemagickFormats: nImage.IMAGEMAGICK_FORMATS,
      },
    };
    ctx.json(200, { success: true, data: caps });
  } catch (error) {
    ctx.error(500, error.message);
  }
}

function buildServiceCapabilities() {
  return {
    version: '1.0.0',
    endpoints: SERVICE_ENDPOINTS,
    features: SERVICE_FEATURES,
    config: {
      maxFileSizeMb: config.maxFileSizeMb,
      maxFileSizeBytes: config.maxFileSizeBytes,
      gpuPlatform: config.gpuPlatform,
      workersMode: config.workersMode,
      maxConcurrentTasks: config.maxConcurrentTasks,
      maxConcurrentUploads: config.maxConcurrentUploads,
      cacheTtl: config.cacheTtl,
      cacheMaxSize: config.cacheMaxSize,
      messageTransport: config.messageTransport,
      allowedInputPaths: config.allowedInputPaths,
      allowedOutputPaths: config.allowedOutputPaths,
      allowUncPaths: config.allowUncPaths,
    },
  };
}

function handleServiceCapabilities(ctx, section) {
  if (section === 'endpoints') {
    ctx.json(200, { success: true, data: SERVICE_ENDPOINTS });
  } else if (section === 'features') {
    ctx.json(200, { success: true, data: SERVICE_FEATURES });
  } else {
    ctx.json(200, { success: true, data: buildServiceCapabilities() });
  }
}

function handleImageCapabilities(ctx, section) {
  if (section === 'formats') {
    ctx.json(200, { success: true, data: nImage.getSupportedFormats() });
  } else if (section === 'state') {
    ctx.json(200, {
      success: true,
      data: {
        isLoaded: nImage.isLoaded,
        hasSharp: nImage.hasSharp,
        version: nImage.version,
      },
    });
  } else if (section === 'raw') {
    ctx.json(200, { success: true, data: nImage.RAW_FORMATS });
  } else if (section === 'heic') {
    ctx.json(200, { success: true, data: nImage.HEIC_FORMATS });
  } else if (section === 'imagemagick') {
    ctx.json(200, { success: true, data: nImage.IMAGEMAGICK_FORMATS });
  } else {
    ctx.json(200, {
      success: true,
      data: {
        ...nImage.getCapabilities(),
        state: {
          isLoaded: nImage.isLoaded,
          hasSharp: nImage.hasSharp,
          version: nImage.version,
        },
        supportedFormats: nImage.getSupportedFormats(),
      },
    });
  }
}

function handleVideoCapabilities(ctx, section) {
  if (section === 'build') {
    const buildInfo = nVideo.getBuildInfo();
    ctx.json(200, { success: true, data: buildInfo });
  } else if (section === 'codecs') {
    const codecs = nVideo.getCapabilities().codecs;
    ctx.json(200, { success: true, data: codecs });
  } else if (section === 'common') {
    const common = nVideo.getCapabilities().commonCodecs;
    ctx.json(200, { success: true, data: common });
  } else if (section === 'filters') {
    const filters = nVideo.getCapabilities().filters;
    ctx.json(200, { success: true, data: filters });
  } else if (section === 'formats') {
    const formats = nVideo.getCapabilities().formats;
    ctx.json(200, { success: true, data: formats });
  } else if (section === 'hwaccels') {
    const buildInfo = nVideo.getBuildInfo();
    ctx.json(200, {
      success: true,
      data: {
        hwaccels: buildInfo.hwaccels || [],
        videoEncodersByHwaccel: nVideo.getCapabilities().commonCodecs.videoEncodersByHwaccel || {},
        recommended: nVideo.getCapabilities().commonCodecs.recommended || {},
      },
    });
  } else {
    const caps = nVideo.getCapabilities();
    ctx.json(200, { success: true, data: caps });
  }
}
