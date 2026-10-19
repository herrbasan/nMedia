import fs from 'fs';
import PipelineExecutor from '../../pipeline/PipelineExecutor.js';
import ProgressReporter from '../../pipeline/ProgressReporter.js';
import { getProcessorHealth } from '../../processors/health.js';
import { logError } from '../../utils/logger.js';

/**
 * POST /v1/process/image
 * Process/resize an image
 */
export async function handleImage(ctx) {
  try {
    let inputBuffer;
    let originalSize;

    // Handle file upload or base64 input
    if (ctx.file) {
      if (ctx.file.tempPath) {
        inputBuffer = fs.readFileSync(ctx.file.tempPath);
      } else {
        inputBuffer = ctx.file.buffer;
      }
      originalSize = ctx.file.size;
    } else if (ctx.body?.base64) {
      // Handle base64 input (strip data URL prefix if present)
      const base64Data = ctx.body.base64.replace(/^data:[^;]+;base64,/, '');
      inputBuffer = Buffer.from(base64Data, 'base64');
      originalSize = inputBuffer.length;
    } else {
      ctx.error(400, 'No file or base64 data provided');
      return;
    }

    const options = {
      max_dimension: parseInt(ctx.body.max_dimension) || 1024,
      quality: parseInt(ctx.body.quality) || 85,
      format: ctx.body.format || 'jpeg',
      strip_exif: ctx.body.strip_exif !== 'false',
    };

    const responseType = ctx.body.response_type || 'base64';

    // Don't open SSE - can't mix SSE headers with file streaming
    const jobId = null;

    // Execute processing
    const result = await PipelineExecutor.execute('image', inputBuffer, options, ProgressReporter, jobId, ctx.requestId);

    // Send final response based on response_type
    if (responseType === 'base64') {
      const base64 = result.buffer.toString('base64');
      const mimeType = result.metadata.mimeType;
      ctx.json(200, {
        original_size_bytes: originalSize,
        processed_size_bytes: result.metadata.outputSize,
        format: result.metadata.format,
        width: result.metadata.width,
        height: result.metadata.height,
        base64: `data:${mimeType};base64,${base64}`,
      });
    } else {
      // Stream as file
      ctx.send(200, result.buffer, result.metadata.mimeType, `processed.${result.metadata.format}`);
    }
  } catch (error) {
    logError('Image processing failed', error, {
      requestId: ctx.requestId,
      inputBytes: ctx.file?.size ?? ctx.body?.base64?.length,
      options: {
        max_dimension: ctx.body?.max_dimension,
        quality: ctx.body?.quality,
        format: ctx.body?.format,
        response_type: ctx.body?.response_type,
      },
    });
    ctx.error(500, error.message);
  }
}

/**
 * POST /v1/process/image/crop
 * Crop an image by region, center, or grid
 */
export async function handleImageCrop(ctx) {
  try {
    let inputBuffer;
    let originalSize;

    // Handle base64 input
    if (ctx.body?.base64) {
      const base64Data = ctx.body.base64.replace(/^data:[^;]+;base64,/, '');
      inputBuffer = Buffer.from(base64Data, 'base64');
      originalSize = inputBuffer.length;
    } else {
      ctx.error(400, 'No base64 data provided');
      return;
    }

    const { crop, quality, format } = ctx.body;

    if (!crop || !crop.type) {
      ctx.error(400, 'crop object with type (region|center|grid) is required');
      return;
    }

    const options = {
      quality: parseInt(quality) || 85,
      format: format || 'jpeg',
      crop,
    };

    const result = await PipelineExecutor.execute('image', inputBuffer, options, ProgressReporter, null, ctx.requestId);

    // Attach base64 data to each crop so clients can actually use the cropped images
    const buffers = [result.buffer, ...(result.extraBuffers || [])];
    const cropsWithBase64 = result.metadata.crops.map((crop, i) => ({
      ...crop,
      base64: buffers[i]?.toString('base64') || '',
    }));

    ctx.json(200, {
      original_size_bytes: originalSize,
      ...result.metadata,
      crops: cropsWithBase64,
    });
  } catch (error) {
    logError('Image crop failed', error, { requestId: ctx.requestId, crop: ctx.body?.crop });
    ctx.error(500, error.message);
  }
}

/**
 * GET /health
 * Health check endpoint. Serves the startup self-check snapshot: probing the
 * backends per request would make health checks expensive and non-deterministic.
 */
export async function handleHealth(ctx) {
  const health = getProcessorHealth();
  if (!health) {
    ctx.error(503, 'Processor health check has not run');
    return;
  }

  const processors = {
    image: health.image.ok ? 'ready' : 'error',
    audio: health.audio.ok ? 'ready' : 'error',
    video: health.video.ok ? 'ready' : 'error',
  };
  const allReady = Object.values(processors).every((state) => state === 'ready');

  const response = {
    status: allReady ? 'ok' : 'degraded',
    uptime: Math.round(process.uptime()),
    processors,
    checkedAt: health.checkedAt,
    backends: {
      image: {
        sharp: health.image.backends.sharp,
        imagemagick: health.image.backends.imagemagick,
        svg: health.image.backends.svg,
      },
      nvideo: health.audio.backends.nvideo,
    },
  };

  if (!allReady) {
    const reasons = {};
    for (const name of ['image', 'audio', 'video']) {
      if (!health[name].ok) reasons[name] = health[name].reason;
    }
    response.reasons = reasons;
  }

  ctx.json(200, response);
}
