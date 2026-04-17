import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from '../../utils/uuid.js';
import { jobStore } from '../../jobs/JobStore.js';
import { assetCache } from '../../cache/AssetCache.js';
import { MagicByteDetector } from '../../utils/MagicByteDetector.js';
import ProgressReporter from '../../pipeline/ProgressReporter.js';
import logger from '../../utils/logger.js';
import config from '../../config/config.js';

// Track upload state per WebSocket connection
const uploadState = new Map();

/**
 * Handle incoming WebSocket messages.
 * @param {WebSocketConnection} conn
 * @param {Object} message - { type: 'text'|'binary', data: string|Buffer }
 * @param {http.IncomingMessage} req
 */
export function handleWebSocketMessage(conn, message, req) {
  if (message.type === 'binary') {
    handleBinaryFrame(conn, message.data);
    return;
  }

  let payload;
  try {
    payload = JSON.parse(message.data);
  } catch (err) {
    conn.send({ type: 'error', message: 'Invalid JSON' });
    return;
  }

  const { type } = payload;

  switch (type) {
    case 'subscribe':
      handleSubscribe(conn, payload);
      break;
    case 'unsubscribe':
      handleUnsubscribe(conn, payload);
      break;
    case 'upload_start':
      handleUploadStart(conn, payload);
      break;
    case 'upload_complete':
      handleUploadComplete(conn, payload);
      break;
    case 'download_request':
      handleDownloadRequest(conn, payload);
      break;
    case 'ping':
      conn.send({ type: 'pong', timestamp: Date.now() });
      break;
    default:
      conn.send({ type: 'error', message: `Unknown message type: ${type}` });
  }
}

function handleSubscribe(conn, payload) {
  const { jobId } = payload;
  if (!jobId) {
    conn.send({ type: 'error', message: 'jobId is required' });
    return;
  }

  const connId = ProgressReporter.registerConnection(conn);
  conn._progressReporterId = connId;
  ProgressReporter.linkJob(connId, jobId);

  const job = jobStore.getJob(jobId);
  if (job) {
    // Send current state immediately
    conn.send({
      type: 'state',
      jobId: job.jobId,
      status: job.status,
      percent: job.percent,
      message: job.message,
      processor: job.processor,
      mode: job.mode,
    });

    // If already completed/failed, send final event
    if (job.status === 'completed') {
      conn.send({
        type: 'complete',
        jobId: job.jobId,
        assetId: job.assetId,
        duration: job.completedAt - job.startedAt,
      });
    } else if (job.status === 'failed') {
      conn.send({
        type: 'error',
        jobId: job.jobId,
        error: job.error,
      });
    } else if (job.status === 'cancelled') {
      conn.send({
        type: 'cancelled',
        jobId: job.jobId,
      });
    }
  }

  conn.send({ type: 'subscribed', jobId });
}

function handleUnsubscribe(conn, payload) {
  const { jobId } = payload;
  if (conn._progressReporterId && jobId) {
    ProgressReporter.close(conn._progressReporterId);
    delete conn._progressReporterId;
  }
  conn.send({ type: 'unsubscribed', jobId });
}

function handleUploadStart(conn, payload) {
  const { uploadId, filename, size } = payload;

  if (!uploadId || !filename || !size) {
    conn.send({ type: 'error', message: 'uploadId, filename, and size are required' });
    return;
  }

  const maxBytes = config.maxFileSizeBytes || Number.MAX_SAFE_INTEGER;
  if (size > maxBytes) {
    conn.send({ type: 'error', message: `File size exceeds maximum ${config.maxFileSizeMb}MB` });
    return;
  }

  const tempId = uuidv4();
  const tempPath = path.join(jobStore.uploadsDir, `ws-upload-${tempId}.bin`);

  try {
    const writeStream = fs.createWriteStream(tempPath);
    uploadState.set(conn.id, {
      uploadId,
      tempPath,
      filename,
      size,
      received: 0,
      writeStream,
    });

    conn.send({ type: 'upload_accepted', uploadId, maxSize: maxBytes });
  } catch (err) {
    logger.error('WebSocket upload start failed', { error: err.message });
    conn.send({ type: 'error', message: 'Failed to start upload' });
  }
}

function handleBinaryFrame(conn, data) {
  const state = uploadState.get(conn.id);
  if (!state) {
    conn.send({ type: 'error', message: 'No active upload. Send upload_start first.' });
    return;
  }

  state.received += data.length;

  if (state.received > state.size) {
    state.writeStream.destroy();
    try { fs.unlinkSync(state.tempPath); } catch {}
    uploadState.delete(conn.id);
    conn.send({ type: 'error', message: 'Upload exceeded declared size' });
    return;
  }

  state.writeStream.write(data);
}

function handleUploadComplete(conn, payload) {
  const { uploadId } = payload;
  const state = uploadState.get(conn.id);

  if (!state || state.uploadId !== uploadId) {
    conn.send({ type: 'error', message: 'No matching upload in progress' });
    return;
  }

  uploadState.delete(conn.id);

  state.writeStream.end(() => {
    try {
      // Magic byte validation
      const header = fs.readFileSync(state.tempPath, { length: 64 });
      const detected = MagicByteDetector.detect(header);

      if (!detected) {
        fs.unlinkSync(state.tempPath);
        conn.send({ type: 'error', message: 'Unable to detect file type' });
        return;
      }

      // Register upload in JobStore
      const upload = jobStore.registerUpload({
        tempPath: state.tempPath,
        originalFilename: filenameSafe(state.filename),
        detectedType: detected.type,
        detectedMimeType: detected.mimeType,
        size: state.received,
        uploadId,
      });

      conn.send({
        type: 'upload_ready',
        fileId: upload.fileId,
        detectedType: upload.detectedType,
        detectedMimeType: upload.detectedMimeType,
        size: upload.size,
        expiresAt: new Date(upload.expiresAt).toISOString(),
      });
    } catch (err) {
      logger.error('WebSocket upload completion failed', { error: err.message });
      try { fs.unlinkSync(state.tempPath); } catch {}
      conn.send({ type: 'error', message: 'Failed to finalize upload' });
    }
  });
}

async function handleDownloadRequest(conn, payload) {
  const { assetId } = payload;
  if (!assetId) {
    conn.send({ type: 'error', message: 'assetId is required' });
    return;
  }

  const asset = assetCache.get(assetId);
  if (!asset) {
    conn.send({ type: 'error', message: 'Asset not found or expired' });
    return;
  }

  if (!fs.existsSync(asset.storagePath)) {
    conn.send({ type: 'error', message: 'Asset file missing' });
    return;
  }

  try {
    const stat = fs.statSync(asset.storagePath);
    conn.send({
      type: 'download_ready',
      assetId,
      size: stat.size,
      mimeType: asset.mimeType,
    });

    // Stream file in chunks to avoid loading large files into memory
    const stream = fs.createReadStream(asset.storagePath);
    stream.on('data', (chunk) => {
      conn.send(chunk);
    });
    stream.on('end', () => {
      conn.send({ type: 'download_complete', assetId });
      assetCache.markRetrieved(assetId);
    });
    stream.on('error', (err) => {
      logger.error('WebSocket download stream error', { error: err.message });
      conn.send({ type: 'error', message: 'Download stream failed' });
    });
  } catch (err) {
    logger.error('WebSocket download failed', { error: err.message });
    conn.send({ type: 'error', message: 'Failed to stream asset' });
  }
}

function filenameSafe(filename) {
  if (!filename) return 'unknown';
  return filename.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').substring(0, 255);
}
