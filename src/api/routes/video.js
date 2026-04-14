import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from '../../utils/uuid.js';
import config from '../../config/config.js';
import PipelineExecutor from '../../pipeline/PipelineExecutor.js';
import ProgressReporter from '../../pipeline/ProgressReporter.js';
import logger from '../../utils/logger.js';

/**
 * POST /v1/process/video
 * Process video (extract audio, keyframes, or transcode)
 *
 * Supports two workflows:
 * 1. File-to-file: { input_path, output_path, mode, ...options }
 * 2. Upload: multipart/form-data with file upload
 */
export async function handleVideo(ctx) {
  try {
    const options = {
      mode: ctx.body.mode || 'extract_audio',
      fps: ctx.body.fps ? parseInt(ctx.body.fps) : undefined,
      format: ctx.body.format || 'jpeg',
      max_dimension: ctx.body.max_dimension ? parseInt(ctx.body.max_dimension) : undefined,
      response_type: ctx.body.response_type || 'base64',
      // Transcode options
      output_format: ctx.body.output_format,
      video_codec: ctx.body.video_codec,
      audio_codec: ctx.body.audio_codec,
      width: ctx.body.width ? parseInt(ctx.body.width) : undefined,
      height: ctx.body.height ? parseInt(ctx.body.height) : undefined,
      crf: ctx.body.crf ? parseInt(ctx.body.crf) : undefined,
      preset: ctx.body.preset,
      audio_bitrate: ctx.body.audio_bitrate ? parseInt(ctx.body.audio_bitrate) : undefined,
    };

    // File-to-file workflow: input_path + output_path provided
    if (ctx.body.input_path && ctx.body.output_path) {
      return handleVideoFileToFile(ctx, options);
    }

    // Upload workflow: file upload or base64
    return handleVideoUpload(ctx, options);
  } catch (error) {
    logger.error('Video processing failed', { error: error.message });
    ctx.error(500, error.message);
  }
}

/**
 * File-to-file video processing
 * Request body: { input_path, output_path, mode, ...options }
 * Response: { success, metadata }
 */
async function handleVideoFileToFile(ctx, options) {
  const inputPath = path.resolve(ctx.body.input_path);
  const outputPath = path.resolve(ctx.body.output_path);

  if (!fs.existsSync(inputPath)) {
    return ctx.json(400, { error: `Input file not found: ${inputPath}` });
  }

  // Ensure output directory exists
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const inputStat = fs.statSync(inputPath);

  // For file-to-file, open SSE for progress
  const jobId = ctx.createSseJob();

  // Pass input_path and output_path in options - processor handles file-to-file directly
  const processorOptions = {
    ...options,
    input_path: inputPath,
    output_path: outputPath,
  };

  const result = await PipelineExecutor.execute('video', null, processorOptions, ProgressReporter, jobId);

  const response = {
    success: true,
    input_path: inputPath,
    output_path: outputPath,
    input_size: inputStat.size,
    output_size: result.metadata.outputSize,
    mode: result.metadata.mode,
  };

  if (result.metadata.mode === 'transcode') {
    response.output_format = result.metadata.outputFormat;
    response.video_codec = result.metadata.videoCodec;
    response.audio_codec = result.metadata.audioCodec;
    response.dimensions = result.metadata.dimensions;
    response.duration = result.metadata.duration;
  } else if (result.metadata.mode === 'extract_keyframes') {
    response.frame_count = result.metadata.frameCount;
  }

  return ctx.json(200, response);
}

/**
 * Upload-based video processing
 * Request: multipart/form-data or base64 JSON
 * Response: base64 or file stream
 */
async function handleVideoUpload(ctx, options) {
  let inputBuffer;
  let inputPath;
  let originalSize;
  let needsCleanup = false;

  // Handle file upload
  if (ctx.file) {
    if (ctx.file.tempPath) {
      // File was streamed to disk - use path directly
      inputPath = ctx.file.tempPath;
      originalSize = ctx.file.size;
      needsCleanup = true;
    } else {
      // File is in memory (small uploads)
      inputBuffer = ctx.file.buffer;
      originalSize = ctx.file.size;
    }
  } else if (ctx.body?.base64) {
    const base64Data = ctx.body.base64.replace(/^data:[^;]+;base64,/, '');
    inputBuffer = Buffer.from(base64Data, 'base64');
    originalSize = inputBuffer.length;
  } else {
    return ctx.json(400, { error: 'No file, base64 data, or input_path provided' });
  }

  const responseType = ctx.body.response_type || 'base64';

  logger.info('Video upload request', {
    responseType,
    mode: options.mode,
    hasFile: !!ctx.file,
    fileSize: ctx.file?.size,
    isStreamed: !!ctx.file?.tempPath,
    allFields: Object.keys(ctx.body || {}),
  });

  // For file-to-file (streamed upload), write directly to output
  if (inputPath && responseType === 'file') {
    // No SSE - can't mix SSE headers with file streaming on same connection
    const outputExt = options.mode === 'transcode' ? (options.output_format || 'mp4') : (options.format || 'mp3');
    const outputPath = path.join(config.cacheDir, `output-${uuidv4()}.${outputExt}`);

    const processorOptions = {
      ...options,
      input_path: inputPath,
      output_path: outputPath,
    };

    const result = await PipelineExecutor.execute('video', null, processorOptions, ProgressReporter, null);

    ctx.send(200, fs.readFileSync(result.outputPath), result.metadata.mimeType, `processed.${outputExt}`);

    // Cleanup
    try { fs.unlinkSync(inputPath); } catch {}
    try { fs.unlinkSync(result.outputPath); } catch {}
    return;
  }

  // For base64 response, read file into buffer if needed
  if (inputPath && !inputBuffer) {
    inputBuffer = fs.readFileSync(inputPath);
  }

  // For file responses, don't open SSE - can't mix SSE headers with file streaming
  // For base64 responses, no SSE needed either (synchronous)
  // SSE is only useful for async/file-to-file workflows with separate progress endpoint
  const jobId = null;

  // Execute processing
  const result = await PipelineExecutor.execute('video', inputBuffer, options, ProgressReporter, jobId);

  // Cleanup temp file
  if (needsCleanup && inputPath) {
    try { fs.unlinkSync(inputPath); } catch {}
  }

  // Send final response based on response_type and mode
  // Force file streaming if buffer is too large for base64 (>400MB)
  const MAX_BASE64_SIZE = 400 * 1024 * 1024;
  const forceFileMode = result.buffer.length > MAX_BASE64_SIZE;
  const effectiveResponseType = forceFileMode ? 'file' : responseType;

  if (effectiveResponseType === 'base64') {
    if (options.mode === 'extract_audio') {
      const base64 = result.buffer.toString('base64');
      ctx.json(200, {
        original_size_bytes: originalSize,
        output_size_bytes: result.metadata.outputSize,
        mode: result.metadata.mode,
        format: result.metadata.format,
        base64: `data:${result.metadata.mimeType};base64,${base64}`,
      });
    } else if (options.mode === 'transcode') {
      const base64 = result.buffer.toString('base64');
      ctx.json(200, {
        original_size_bytes: originalSize,
        output_size_bytes: result.metadata.outputSize,
        mode: result.metadata.mode,
        output_format: result.metadata.outputFormat,
        video_codec: result.metadata.videoCodec,
        audio_codec: result.metadata.audioCodec,
        dimensions: result.metadata.dimensions,
        duration: result.metadata.duration,
        base64: `data:${result.metadata.mimeType};base64,${base64}`,
      });
    } else {
      ctx.json(200, {
        original_size_bytes: originalSize,
        frame_count: result.metadata.frameCount,
        mode: result.metadata.mode,
        frames_base64: result.buffer.toString('base64'),
      });
    }
  } else {
    if (options.mode === 'extract_audio') {
      ctx.send(200, result.buffer, result.metadata.mimeType, 'audio.mp3');
    } else if (options.mode === 'transcode') {
      const ext = result.metadata.outputFormat || 'mp4';
      ctx.send(200, result.buffer, result.metadata.mimeType, `transcoded.${ext}`);
    } else {
      ctx.send(200, result.buffer, 'image/jpeg', 'frames.jpg');
    }
  }
}

/**
 * SSE progress endpoint for video jobs.
 * GET /v1/process/progress/:jobId
 */
export async function handleVideoProgress(ctx) {
  const { jobId } = ctx.params;

  // Create SSE connection
  const actualJobId = ctx.createSseJob();

  // Send initial connection message
  ProgressReporter.send(actualJobId, 'connected', { jobId: actualJobId });
}
