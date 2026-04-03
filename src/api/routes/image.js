import config from '../../config/config.js';
import PipelineExecutor from '../../pipeline/PipelineExecutor.js';
import ProgressReporter from '../../pipeline/ProgressReporter.js';
import logger from '../../utils/logger.js';

/**
 * POST /v1/optimize/image
 * Optimize/resize an image
 */
export async function handleImage(ctx) {
  try {
    let inputBuffer;
    let originalSize;

    // Handle file upload or base64 input
    if (ctx.file) {
      inputBuffer = ctx.file.buffer;
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
      response_type: ctx.body.response_type || 'base64',
    };

    const responseType = ctx.body.response_type || 'base64';

    // Only use SSE for progress reporting if not requesting base64 response
    let jobId = null;
    if (responseType !== 'base64') {
      jobId = ctx.createSseJob();
    }

    // Execute processing
    const result = await PipelineExecutor.execute('image', inputBuffer, options, ProgressReporter, jobId);

    // Send final response based on response_type
    if (responseType === 'base64') {
      const base64 = result.buffer.toString('base64');
      const mimeType = result.metadata.mimeType;
      ctx.json(200, {
        original_size_bytes: originalSize,
        optimized_size_bytes: result.metadata.outputSize,
        format: result.metadata.format,
        width: result.metadata.width,
        height: result.metadata.height,
        base64: `data:${mimeType};base64,${base64}`,
      });
    } else {
      // Stream as file
      ctx.send(200, result.buffer, result.metadata.mimeType, `optimized.${result.metadata.format}`);
    }
  } catch (error) {
    logger.error('Image optimization failed', { error: error.message });
    ctx.error(500, error.message);
  }
}

/**
 * POST /v1/optimize/image/crop
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

    const result = await PipelineExecutor.execute('image', inputBuffer, options, ProgressReporter);

    ctx.json(200, {
      original_size_bytes: originalSize,
      ...result.metadata,
    });
  } catch (error) {
    logger.error('Image crop failed', { error: error.message });
    ctx.error(500, error.message);
  }
}

/**
 * GET /health
 * Health check endpoint
 */
export async function handleHealth(ctx) {
  const health = {
    status: 'ok',
    processors: {
      image: 'unknown',
      audio: 'unknown',
      video: 'unknown',
    },
  };

  // Check if sharp is available
  try {
    await import('sharp');
    health.processors.image = 'ready';
  } catch (e) {
    health.processors.image = 'error';
  }

  // Check ffmpeg (basic check)
  try {
    await import('fluent-ffmpeg');
    health.processors.audio = 'ready';
    health.processors.video = 'ready';
  } catch (e) {
    health.processors.audio = 'error';
    health.processors.video = 'error';
  }

  const allReady = Object.values(health.processors).every((s) => s === 'ready');
  health.status = allReady ? 'ok' : 'degraded';

  ctx.json(200, health);
}