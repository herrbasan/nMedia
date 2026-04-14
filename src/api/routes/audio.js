import PipelineExecutor from '../../pipeline/PipelineExecutor.js';
import ProgressReporter from '../../pipeline/ProgressReporter.js';
import logger from '../../utils/logger.js';
import AudioProcessor from '../../processors/audio/AudioProcessor.js';

/**
 * POST /v1/audio/probe
 * Extract metadata from audio file
 */
export async function handleAudioProbe(ctx) {
  try {
    let inputBuffer;
    
    // Debug logging
    logger.info('Audio probe request', { 
      hasFile: !!ctx.file, 
      hasBody: !!ctx.body,
      contentType: ctx.headers['content-type'],
      fileField: ctx.file ? { name: ctx.file.fieldname, size: ctx.file.size } : null
    });
    
    // Handle file upload or base64 input
    if (ctx.file) {
      inputBuffer = ctx.file.buffer;
    } else if (ctx.body?.base64) {
      const base64Data = ctx.body.base64.replace(/^data:[^;]+;base64,/, '');
      inputBuffer = Buffer.from(base64Data, 'base64');
    } else {
      return ctx.json(400, { error: 'No file provided' });
    }

    // Get the audio processor and probe
    const processor = new AudioProcessor();
    
    const metadata = await processor.probe(inputBuffer);
    
    return ctx.json(200, {
      success: true,
      metadata,
    });
  } catch (error) {
    logger.error('Audio probe failed', { error: error.message });
    return ctx.json(500, { error: error.message });
  }
}

/**
 * POST /v1/process/audio
 * Process/convert audio
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
      return ctx.json(400, { error: 'No file provided' });
    }

    // Parse options - support 'source' for sample_rate and channels
    const sampleRateValue = ctx.body.sample_rate || '16000';
    const channelsValue = ctx.body.channels || '1';
    
    const options = {
      sample_rate: sampleRateValue === 'source' ? 'source' : parseInt(sampleRateValue),
      channels: channelsValue === 'source' ? 'source' : parseInt(channelsValue),
      format: ctx.body.format || 'mp3',
    };

    const responseType = ctx.body.response_type || 'base64';

    // For synchronous (base64) responses, don't open SSE - just process and return
    // For file responses, open SSE for progress tracking
    let jobId = null;
    if (responseType !== 'base64') {
      jobId = ctx.createSseJob();
    }

    // Execute processing
    const result = await PipelineExecutor.execute('audio', inputBuffer, options, ProgressReporter, jobId);

    // Send final response based on response_type
    if (responseType === 'base64') {
      const base64 = result.buffer.toString('base64');
      const mimeType = result.metadata.mimeType;
      return ctx.json(200, {
        original_size_bytes: originalSize,
        processed_size_bytes: result.metadata.outputSize,
        sample_rate: result.metadata.sampleRate,
        channels: result.metadata.channels,
        format: result.metadata.format,
        source_metadata: result.metadata.sourceMetadata,
        base64: `data:${mimeType};base64,${base64}`,
      });
    } else {
      ctx.rawResponse.setHeader('Content-Type', result.metadata.mimeType);
      ctx.rawResponse.setHeader('Content-Disposition', `attachment; filename="processed.${result.metadata.format}"`);
      ctx.rawResponse.end(result.buffer);
      return;
    }
  } catch (error) {
    logger.error('Audio processing failed', { error: error.message });
    return ctx.json(500, { error: error.message });
  }
}
