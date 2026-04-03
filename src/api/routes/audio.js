import PipelineExecutor from '../../pipeline/PipelineExecutor.js';
import ProgressReporter from '../../pipeline/ProgressReporter.js';
import logger from '../../utils/logger.js';

/**
 * POST /v1/optimize/audio
 * Optimize/resample audio
 */
export async function handleAudio(ctx) {
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
      sample_rate: parseInt(ctx.body.sample_rate) || 16000,
      channels: parseInt(ctx.body.channels) || 1,
      format: ctx.body.format || 'mp3',
      response_type: ctx.body.response_type || 'base64',
    };

    const responseType = ctx.body.response_type || 'base64';

    // Create SSE connection for progress
    const jobId = ctx.createSseJob();

    // Execute processing
    const result = await PipelineExecutor.execute('audio', inputBuffer, options, ProgressReporter, jobId);

    // Send final response based on response_type
    if (responseType === 'base64') {
      const base64 = result.buffer.toString('base64');
      const mimeType = result.metadata.mimeType;
      ctx.json(200, {
        original_size_bytes: originalSize,
        optimized_size_bytes: result.metadata.outputSize,
        sample_rate: result.metadata.sampleRate,
        channels: result.metadata.channels,
        format: result.metadata.format,
        base64: `data:${mimeType};base64,${base64}`,
      });
    } else {
      ctx.send(200, result.buffer, result.metadata.mimeType, `optimized.${result.metadata.format}`);
    }
  } catch (error) {
    logger.error('Audio optimization failed', { error: error.message });
    ctx.error(500, error.message);
  }
}