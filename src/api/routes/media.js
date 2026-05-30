import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createRequire } from 'module';
import config from '../../config/config.js';
import logger from '../../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load native modules
const nVideoPath = path.join(__dirname, '../../../modules/nVideo/lib/index.js');
const nImagePath = path.join(__dirname, '../../../modules/nImage/lib/index.js');
const require = createRequire(import.meta.url);
const nVideo = require(nVideoPath);
let nImage;
try {
  nImage = (await import(pathToFileURL(nImagePath).href)).default;
} catch (e) {
  throw new Error(`nImage module not found. Error: ${e.message}`);
}

// --------------------------------------------------------------------------
// Helper: validate and resolve input path
// --------------------------------------------------------------------------
function _resolveInputPath(rawPath) {
  if (!rawPath) {
    throw new Error('Path is required');
  }

  // Decode URL-encoded path
  const decodedPath = decodeURIComponent(rawPath);

  // Validate against allowlist
  if (!_isPathAllowed(decodedPath, config.allowedInputPaths)) {
    throw new Error(`Path not in allowed directories. Allowed: ${config.allowedInputPaths.join(', ')}`);
  }

  // Check existence and readability
  if (!fs.existsSync(decodedPath)) {
    throw new Error(`File not found: ${decodedPath}`);
  }

  try {
    fs.accessSync(decodedPath, fs.constants.R_OK);
  } catch {
    throw new Error(`File not readable: ${decodedPath}`);
  }

  return decodedPath;
}

function _isPathAllowed(checkPath, allowedList) {
  if (!allowedList || allowedList.length === 0) return false;
  if (allowedList.includes('*')) return true;
  return allowedList.some(allowed => checkPath.startsWith(allowed));
}

// --------------------------------------------------------------------------
// Helper: detect media type from file extension and magic bytes
// --------------------------------------------------------------------------
function _detectMediaType(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tiff', '.tif', '.avif', '.heic', '.heif', '.cr2', '.nef', '.arw', '.orf', '.dng', '.raw']);
  const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm', '.flv', '.wmv', '.m4v', '.ts', '.m2ts']);
  const AUDIO_EXTS = new Set(['.mp3', '.wav', '.flac', '.aac', '.m4a', '.ogg', '.opus', '.wma']);

  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (AUDIO_EXTS.has(ext)) return 'audio';

  // Fallback: probe with nVideo
  try {
    const probe = nVideo.probe(filePath);
    const hasVideo = probe.streams.some(s => s.type === 'video');
    const hasAudio = probe.streams.some(s => s.type === 'audio');
    if (hasVideo) return 'video';
    if (hasAudio) return 'audio';
  } catch {
    // nVideo probe failed, try nImage
  }

  // Try nImage as last resort
  try {
    if (nImage.isLoaded) {
      return 'image';
    }
  } catch {
    // nImage not available
  }

  return 'unknown';
}

// --------------------------------------------------------------------------
// GET /v1/thumbnail/* — Best-effort thumbnail
// --------------------------------------------------------------------------
export async function handleThumbnail(ctx) {
  try {
    const rawPath = ctx.params['*'];
    const inputPath = _resolveInputPath(rawPath);
    const width = parseInt(ctx.query.width) || 256;

    logger.info('Thumbnail request', { path: inputPath, width });

    const mediaType = _detectMediaType(inputPath);
    let thumbnailBuffer;
    let mimeType = 'image/jpeg';

    if (mediaType === 'image') {
      thumbnailBuffer = await _thumbnailImage(inputPath, width);
    } else if (mediaType === 'video') {
      thumbnailBuffer = await _thumbnailVideo(inputPath, width);
    } else if (mediaType === 'audio') {
      ctx.error(415, 'Audio files do not support thumbnails');
      return;
    } else {
      ctx.error(415, 'Unsupported file type for thumbnail');
      return;
    }

    ctx.send(200, thumbnailBuffer, mimeType, 'thumbnail.jpg');
  } catch (error) {
    logger.error('Thumbnail failed', { error: error.message, path: ctx.params['*'] });
    if (error.message.includes('not found')) {
      ctx.error(404, error.message);
    } else if (error.message.includes('not in allowed')) {
      ctx.error(403, error.message);
    } else {
      ctx.error(500, error.message);
    }
  }
}

async function _thumbnailImage(inputPath, width) {
  // Use nImage for image thumbnails
  const result = await nImage(inputPath)
    .resize(width, null, { withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();
  return result;
}

async function _thumbnailVideo(inputPath, width) {
  // Use nVideo.thumbnail() to extract a frame at 1 second
  const thumb = nVideo.thumbnail(inputPath, { timestamp: 1, width });
  // Convert RGB24 to JPEG via nImage
  const jpegBuffer = await nImage({
    data: thumb.data,
    width: thumb.width,
    height: thumb.height,
    channels: 3,
  }).jpeg({ quality: 85 }).toBuffer();
  return jpegBuffer;
}

// --------------------------------------------------------------------------
// GET /v1/info/* — Detailed media file info
// --------------------------------------------------------------------------
export async function handleInfo(ctx) {
  try {
    const rawPath = ctx.params['*'];
    const inputPath = _resolveInputPath(rawPath);

    logger.info('Info request', { path: inputPath });

    const mediaType = _detectMediaType(inputPath);
    let info;

    if (mediaType === 'image') {
      info = await _infoImage(inputPath);
    } else if (mediaType === 'video' || mediaType === 'audio') {
      info = await _infoVideoAudio(inputPath);
    } else {
      // Try both as fallback
      try {
        info = await _infoVideoAudio(inputPath);
      } catch {
        try {
          info = await _infoImage(inputPath);
        } catch {
          ctx.error(415, 'Unable to probe file format');
          return;
        }
      }
    }

    ctx.json(200, {
      path: inputPath,
      mediaType,
      ...info,
    });
  } catch (error) {
    logger.error('Info request failed', { error: error.message, path: ctx.params['*'] });
    if (error.message.includes('not found')) {
      ctx.error(404, error.message);
    } else if (error.message.includes('not in allowed')) {
      ctx.error(403, error.message);
    } else {
      ctx.error(500, error.message);
    }
  }
}

async function _infoImage(inputPath) {
  const stats = fs.statSync(inputPath);
  const result = await nImage(inputPath).metadata();
  return {
    format: result.format,
    width: result.width,
    height: result.height,
    channels: result.channels,
    hasAlpha: result.hasAlpha,
    size: stats.size,
    modifiedAt: stats.mtime.toISOString(),
  };
}

async function _infoVideoAudio(inputPath) {
  const probe = nVideo.probe(inputPath);
  const stats = fs.statSync(inputPath);

  const videoStream = probe.streams.find(s => s.type === 'video');
  const audioStream = probe.streams.find(s => s.type === 'audio');

  return {
    duration: probe.format.duration,
    bitrate: probe.format.bit_rate,
    format: probe.format.format_name,
    size: stats.size,
    modifiedAt: stats.mtime.toISOString(),
    video: videoStream ? {
      codec: videoStream.codec,
      width: videoStream.width,
      height: videoStream.height,
      fps: videoStream.fps,
      pixFmt: videoStream.pix_fmt,
      bitrate: videoStream.bit_rate,
    } : null,
    audio: audioStream ? {
      codec: audioStream.codec,
      sampleRate: audioStream.sample_rate,
      channels: audioStream.channels,
      bitrate: audioStream.bit_rate,
    } : null,
    streams: probe.streams.map(s => ({
      type: s.type,
      codec: s.codec,
      index: s.index,
    })),
  };
}
