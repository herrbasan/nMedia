import fs from 'fs';
import { jobStore, JobStatus } from '../../jobs/JobStore.js';
import { taskManager } from '../../tasks/TaskManager.js';
import { Task } from '../../tasks/Task.js';
import ProgressReporter from '../../pipeline/ProgressReporter.js';
import logger from '../../utils/logger.js';
import config from '../../config/config.js';

const VALID_PROCESSORS = ['image', 'audio', 'video'];
const VALID_VIDEO_MODES = ['extract_audio', 'extract_keyframes', 'transcode', 'cli'];

/**
 * POST /v1/process
 * Unified processing endpoint.
 * Supports two patterns:
 * - Pattern A: { input_path, processor, options } - path-based processing
 * - Pattern B: { fileId, processor, options } - upload-to-cache processing
 * Returns jobId immediately, progress via SSE.
 */
export async function handleProcess(ctx) {
  try {
    const body = ctx.body;

    if (!body || typeof body !== 'object') {
      ctx.error(400, 'Request body must be JSON');
      return;
    }

    const { input_path, fileId, processor, mode, options = {}, output_path } = body;
    logger.info('Process request received', { processor, mode, optionsKeys: Object.keys(options), hasFileId: !!fileId, hasInputPath: !!input_path });

    // Validate processor type
    if (!processor || !VALID_PROCESSORS.includes(processor)) {
      ctx.error(400, `Invalid processor. Must be one of: ${VALID_PROCESSORS.join(', ')}`);
      return;
    }

    // Validate input source - must have either input_path or fileId
    if (input_path && fileId) {
      ctx.error(400, 'Provide either input_path or fileId, not both');
      return;
    }

    if (!input_path && !fileId) {
      ctx.error(400, 'Either input_path or fileId is required');
      return;
    }

    // Pattern A: Path-based processing
    if (input_path) {
      return await _handlePathBased(ctx, input_path, processor, mode, options, output_path);
    }

    // Pattern B: Upload-to-cache processing
    return await _handleUploadBased(ctx, fileId, processor, mode, options, output_path);
  } catch (error) {
    logger.error('Process request failed', { error: error.message });
    ctx.error(500, error.message);
  }
}

async function _handlePathBased(ctx, inputPath, processor, mode, options, outputPath) {
  // Validate input path against allowlist
  if (!_isPathAllowed(inputPath, config.allowedInputPaths)) {
    ctx.error(403, `Input path not in allowed directories. Allowed: ${config.allowedInputPaths.join(', ')}`);
    return;
  }

  // Validate output path if provided
  if (outputPath && !_isPathAllowed(outputPath, config.allowedOutputPaths)) {
    ctx.error(403, `Output path not in allowed directories. Allowed: ${config.allowedOutputPaths.join(', ')}`);
    return;
  }

  // Pre-flight file access check
  if (!fs.existsSync(inputPath)) {
    ctx.error(400, `File not found: ${inputPath}`);
    return;
  }

  try {
    fs.accessSync(inputPath, fs.constants.R_OK);
  } catch {
    ctx.error(403, `File not readable: ${inputPath}`);
    return;
  }

  // Validate video mode if applicable
  if (processor === 'video' && mode && !VALID_VIDEO_MODES.includes(mode)) {
    ctx.error(400, `Invalid video mode. Must be one of: ${VALID_VIDEO_MODES.join(', ')}`);
    return;
  }

  // Create job
  const job = jobStore.createJob({
    inputPath,
    processor,
    mode,
    options,
    outputPath,
  });

  // Create task and submit to queue
  const task = _createTask(job);
  await taskManager.submitTask(task);

  logger.info('Path-based job created', {
    jobId: job.jobId,
    processor,
    mode,
    inputPath,
    taskId: task.id,
  });

  ctx.json(200, {
    jobId: job.jobId,
    status: job.status,
    queuePosition: job.queuePosition,
    progress_url: `/v1/jobs/${job.jobId}/progress`,
    poll_url: `/v1/jobs/${job.jobId}`,
  });
}

async function _handleUploadBased(ctx, fileId, processor, mode, options, outputPath) {
  // Get upload from store
  const upload = jobStore.getUpload(fileId);
  if (!upload) {
    ctx.error(404, `Upload not found or expired: ${fileId}`);
    return;
  }

  // Validate processor matches detected type
  if (upload.detectedType !== processor) {
    ctx.error(400, `Upload detected as ${upload.detectedType}, but processor is ${processor}`);
    return;
  }

  // Validate video mode if applicable
  if (processor === 'video' && mode && !VALID_VIDEO_MODES.includes(mode)) {
    ctx.error(400, `Invalid video mode. Must be one of: ${VALID_VIDEO_MODES.join(', ')}`);
    return;
  }

  // Create job
  const job = jobStore.createJob({
    fileId,
    processor,
    mode,
    options,
    outputPath,
  });

  // Mark upload as processed (extends lifetime)
  jobStore.markUploadProcessed(fileId);

  // Create task and submit to queue
  const task = _createTask(job);
  await taskManager.submitTask(task);

  logger.info('Upload-based job created', {
    jobId: job.jobId,
    fileId,
    processor,
    mode,
    taskId: task.id,
    queuePosition: job.queuePosition,
  });

  ctx.json(200, {
    jobId: job.jobId,
    status: job.status,
    queuePosition: job.queuePosition,
    progress_url: `/v1/jobs/${job.jobId}/progress`,
    poll_url: `/v1/jobs/${job.jobId}`,
  });
}

function _createTask(job) {
  const task = new Task(
    job.jobId,
    job.processor,
    job.inputPath || job.fileId,
    { ...job.options, mode: (job.mode != null && job.mode !== '') ? job.mode : job.options.mode },
    ProgressReporter
  );

  // Store job reference on task for worker access
  task._jobId = job.jobId;
  task.outputPath = job.outputPath || null;

  return task;
}

function _isPathAllowed(checkPath, allowedList) {
  if (!allowedList || allowedList.length === 0) return false;
  if (allowedList.includes('*')) return true;
  return allowedList.some(allowed => checkPath.startsWith(allowed));
}
