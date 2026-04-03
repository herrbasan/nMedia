import ffmpeg from 'fluent-ffmpeg';
import { Readable, Writable } from 'stream';
import Processor from '../../pipeline/Processor.js';
import config from '../../config/config.js';
import logger from '../../utils/logger.js';

// Set ffmpeg path
if (config.ffmpegPath) {
  ffmpeg.setFfmpegPath(config.ffmpegPath);
}

/**
 * Video processor using ffmpeg
 * Supports extracting audio or keyframes
 */
class VideoProcessor extends Processor {
  constructor() {
    super('video');
  }

  validateOptions(options) {
    const { mode, fps } = options;

    if (mode !== undefined && !['extract_audio', 'extract_keyframes'].includes(mode)) {
      throw new Error('mode must be extract_audio or extract_keyframes');
    }
    if (fps !== undefined && (fps < 1 || fps > 30)) {
      throw new Error('fps must be between 1 and 30');
    }
  }

  process(input, options = {}, onProgress) {
    const {
      mode = 'extract_audio',
      fps = 1,
    } = options;

    onProgress?.(5, `Starting video processing: ${mode}`);

    if (mode === 'extract_audio') {
      return this.extractAudio(input, options, onProgress);
    } else {
      return this.extractKeyframes(input, options, onProgress);
    }
  }

  extractAudio(input, options, onProgress) {
    return new Promise((resolve, reject) => {
      const { format = 'mp3' } = options;

      onProgress?.(10, 'Extracting audio track');

      let command = ffmpeg()
        .input(Readable.from(input))
        .noVideo()
        .audioCodec('libmp3lame')
        .audioBitrate('128k');

      onProgress?.(30, `Converting to ${format}`);

      const chunks = [];

      command
        .on('progress', (progress) => {
          const percent = Math.min(90, 30 + Math.round((progress.percent || 0) * 0.6));
          onProgress?.(percent, `Processing: ${Math.round(progress.percent || 0)}%`);
        })
        .on('error', (err) => {
          logger.error('Video audio extraction error', { error: err.message });
          reject(err);
        })
        .on('end', () => {
          onProgress?.(100, 'Complete');
          const outputBuffer = Buffer.concat(chunks);

          logger.info('Audio extracted from video', {
            originalSize: input.length,
            outputSize: outputBuffer.length,
          });

          resolve({
            buffer: outputBuffer,
            metadata: {
              originalSize: input.length,
              outputSize: outputBuffer.length,
              mode: 'extract_audio',
              format,
              mimeType: 'audio/mpeg',
            },
          });
        })
        .pipe(new Writable({
          write(chunk, enc, cb) {
            chunks.push(chunk);
            cb();
          },
        }));
    });
  }

  extractKeyframes(input, options, onProgress) {
    return new Promise((resolve, reject) => {
      const { fps = 1, format = 'jpeg', max_dimension = 1024 } = options;

      onProgress?.(10, `Extracting keyframes at ${fps} fps`);

      let command = ffmpeg()
        .input(Readable.from(input))
        .outputOptions([
          `-vf fps=${fps},scale=${max_dimension}:-1:flags=lanczos`,
          '-q:v', '2', // High quality JPEG
        ])
        .outputFormat('image2pipe');

      onProgress?.(30, 'Extracting frames');

      const chunks = [];
      let frameCount = 0;

      command
        .on('progress', (progress) => {
          if (progress.frames) {
            frameCount = progress.frames;
            const percent = Math.min(90, 30 + Math.round((frameCount % 100) * 0.6));
            onProgress?.(percent, `Extracted ${frameCount} frames`);
          }
        })
        .on('error', (err) => {
          logger.error('Video keyframe extraction error', { error: err.message });
          reject(err);
        })
        .on('end', () => {
          onProgress?.(100, 'Complete');

          logger.info('Keyframes extracted from video', {
            originalSize: input.length,
            frameCount,
          });

          resolve({
            buffer: Buffer.concat(chunks),
            metadata: {
              originalSize: input.length,
              frameCount,
              mode: 'extract_keyframes',
              format,
              mimeType: 'image/jpeg',
            },
          });
        })
        .pipe(new Writable({
          write(chunk, enc, cb) {
            chunks.push(chunk);
            cb();
          },
        }));
    });
  }
}

export default VideoProcessor;
