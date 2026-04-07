import PipelineExecutor from '../../pipeline/PipelineExecutor.js';
import ProgressReporter from '../../pipeline/ProgressReporter.js';
import logger from '../../utils/logger.js';

/**
 * POST /v1/process/video
 * Process video (extract audio or keyframes)
 */
export async function handleVideo(ctx) {
  try {
    let inputBuffer;
    let originalSize;

    // Handle file upload or base64 input
    if (ctx.file) {
      inputBuffer = ctx.file.buffer;
      originalSize = ctx.file.size;
    } else if (ctx.body?.base64) {
      const base64Data = ctx.body.base64.replace(/^data:[^;]+;base64,/, '');
      inputBuffer = Buffer.from(base64Data, 'base64');
      originalSize = inputBuffer.length;
    } else {
      ctx.error(400, 'No file or base64 data provided');
      return;
    }

    const options = {
      mode: ctx.body.mode || 'extract_audio',
      fps: parseInt(ctx.body.fps) || 1,
      format: ctx.body.format || 'jpeg',
      max_dimension: parseInt(ctx.body.max_dimension) || 1024,
      response_type: ctx.body.response_type || 'base64',
    };

    const responseType = ctx.body.response_type || 'base64';

    // Create SSE connection for progress
    const jobId = ctx.createSseJob();

    // Execute processing
    const result = await PipelineExecutor.execute('video', inputBuffer, options, ProgressReporter, jobId);

    // Send final response based on response_type and mode
    if (responseType === 'base64') {
      if (options.mode === 'extract_audio') {
        const base64 = result.buffer.toString('base64');
        ctx.json(200, {
          original_size_bytes: originalSize,
          output_size_bytes: result.metadata.outputSize,
          mode: result.metadata.mode,
          format: result.metadata.format,
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
      } else {
        ctx.send(200, result.buffer, 'image/jpeg', 'frames.jpg');
      }
    }
  } catch (error) {
    logger.error('Video processing failed', { error: error.message });
    ctx.error(500, error.message);
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