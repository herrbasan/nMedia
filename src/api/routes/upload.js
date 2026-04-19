import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from '../../utils/uuid.js';
import { jobStore } from '../../jobs/JobStore.js';
import { MagicByteDetector } from '../../utils/MagicByteDetector.js';
import logger from '../../utils/logger.js';
import config from '../../config/config.js';

// Track active uploads for concurrency limiting
let activeUploads = 0;
const MAX_CONCURRENT_UPLOADS = config.maxConcurrentUploads || 4;

/**
 * POST /v1/upload
 * Stream raw binary upload to temp file.
 * Requires Content-Length header for pre-flight disk check.
 * Validates magic bytes after upload completes.
 */
export async function handleUpload(ctx) {
  try {
    // Check concurrency limit
    if (activeUploads >= MAX_CONCURRENT_UPLOADS) {
      ctx.error(429, 'Too many concurrent uploads. Try again later.');
      return;
    }

    // Require Content-Length
    const contentLength = parseInt(ctx.headers['content-length']);
    if (!contentLength || isNaN(contentLength)) {
      ctx.error(411, 'Content-Length header is required');
      return;
    }

    // Pre-flight size check
    const maxBytes = config.maxFileSizeBytes || 9007199254740991;
    if (contentLength > maxBytes) {
      ctx.error(413, `File size ${formatBytes(contentLength)} exceeds maximum ${formatBytes(maxBytes)}`);
      return;
    }

    // Pre-flight disk space check
    const availableSpace = getAvailableDiskSpace(config.cacheDir);
    if (contentLength > availableSpace) {
      ctx.error(507, `Insufficient disk space. Required: ${formatBytes(contentLength)}, Available: ${formatBytes(availableSpace)}`);
      return;
    }

    // Get metadata from headers
    const originalFilename = ctx.headers['x-original-filename'] || 'unknown';
    const uploadId = ctx.headers['x-upload-id'] || null;

    // Create temp file path
    const tempId = uuidv4();
    const tempPath = path.join(jobStore.uploadsDir, `upload-${tempId}.bin`);

    logger.info('Upload started', { tempId, originalFilename, contentLength, activeUploads: activeUploads + 1 });

    activeUploads++;
    let uploadComplete = false;
    let bytesReceived = 0;

    try {
      // Stream request body to temp file
      const writeStream = fs.createWriteStream(tempPath);
      let streamError = null;

      let requestEnded = false;

      const streamComplete = new Promise((resolve, reject) => {
        ctx.rawRequest.on('close', () => {
          if (!uploadComplete && !streamError && !requestEnded) {
            writeStream.destroy();
            try { fs.unlinkSync(tempPath); } catch {}
            reject(new Error('Connection aborted'));
          }
        });

        ctx.rawRequest.on('error', (err) => {
          writeStream.destroy();
          try { fs.unlinkSync(tempPath); } catch {}
          reject(err);
        });

        writeStream.on('finish', () => {
          if (streamError) reject(streamError);
          else resolve();
        });
        writeStream.on('error', reject);
      });

      ctx.rawRequest.on('end', () => {
        requestEnded = true;
        writeStream.end();
      });

      ctx.rawRequest.on('data', (chunk) => {
        bytesReceived += chunk.length;
        if (bytesReceived > contentLength) {
          streamError = new Error('Upload exceeded Content-Length');
          writeStream.destroy();
          try { fs.unlinkSync(tempPath); } catch {}
          return;
        }
        writeStream.write(chunk);
        if (bytesReceived % (1024 * 1024 * 50) < chunk.length) {
          logger.info('Upload progress', { tempId, bytesReceived, percent: Math.round((bytesReceived / contentLength) * 100) });
        }
      });

      await streamComplete;

      uploadComplete = true;
      logger.info('Upload complete', { tempId, bytesReceived, originalFilename });

      // Magic byte validation
      const header = fs.readFileSync(tempPath, { length: 64 });
      let detected = MagicByteDetector.detect(header);
      logger.info('Upload magic bytes detected', { tempId, detectedType: detected?.type, detectedMimeType: detected?.mimeType });

      if (!detected) {
        detected = MagicByteDetector.detectFromExtension(originalFilename);
        logger.info('Upload extension fallback', { tempId, originalFilename, detectedType: detected?.type, detectedMimeType: detected?.mimeType });
      }

      if (!detected) {
        fs.unlinkSync(tempPath);
        ctx.error(415, 'Unable to detect file type. Supported formats: JPEG, PNG, GIF, WebP, AVIF, HEIC, MP3, WAV, OGG, FLAC, MP4, MOV, WebM, AVI');
        return;
      }

      // Register upload in JobStore
      const upload = jobStore.registerUpload({
        tempPath,
        originalFilename,
        detectedType: detected.type,
        detectedMimeType: detected.mimeType,
        size: bytesReceived,
        uploadId,
      });

      logger.info('Upload stored', { fileId: upload.fileId, tempPath, detectedType: detected.type, size: bytesReceived });

      const expiresAt = new Date(upload.expiresAt).toISOString();

      ctx.json(200, {
        fileId: upload.fileId,
        size: upload.size,
        detectedType: upload.detectedType,
        detectedMimeType: upload.detectedMimeType,
        expiresAt,
        status: 'ready',
      });
    } finally {
      activeUploads--;
    }
  } catch (error) {
    if (error.message === 'Connection aborted') {
      logger.debug('Upload connection aborted');
      return;
    }
    logger.error('Upload failed', { error: error.message });
    ctx.error(500, error.message);
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

function getAvailableDiskSpace(dir) {
  // Node.js doesn't have a built-in disk space API, return Infinity
  // In production, use a native module or system call
  return Infinity;
}
