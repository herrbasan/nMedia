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
 * Audio processor using ffmpeg
 */
class AudioProcessor extends Processor {
  constructor() {
    super('audio');
  }

  validateOptions(options) {
    const { sample_rate, channels, format } = options;

    if (sample_rate !== undefined && ![8000, 16000, 22050, 44100, 48000].includes(sample_rate)) {
      throw new Error('sample_rate must be 8000, 16000, 22050, 44100, or 48000');
    }
    if (channels !== undefined && ![1, 2].includes(channels)) {
      throw new Error('channels must be 1 (mono) or 2 (stereo)');
    }
    if (format !== undefined && !['mp3', 'wav', 'ogg', 'm4a'].includes(format)) {
      throw new Error('format must be mp3, wav, ogg, or m4a');
    }
  }

  process(input, options = {}, onProgress) {
    return new Promise((resolve, reject) => {
      const {
        sample_rate = 16000,
        channels = 1, // mono for STT
        format = 'mp3',
      } = options;

      onProgress?.(5, 'Processing audio');

      let command = ffmpeg()
        .input(Readable.from(input))
        .audioChannels(channels)
        .audioFrequency(sample_rate);

      // Set output format
      switch (format) {
        case 'mp3':
          command = command.audioCodec('libmp3lame').audioBitrate('128k');
          break;
        case 'wav':
          command = command.audioCodec('pcm_s16le');
          break;
        case 'ogg':
          command = command.audioCodec('libvorbis').audioBitrate('128k');
          break;
        case 'm4a':
          command = command.audioCodec('aac').audioBitrate('128k');
          break;
      }

      onProgress?.(30, `Converting to ${format}`);

      const chunks = [];

      command
        .on('progress', (progress) => {
          const percent = Math.min(90, 30 + Math.round((progress.percent || 0) * 0.6));
          onProgress?.(percent, `Processing: ${Math.round(progress.percent || 0)}%`);
        })
        .on('error', (err) => {
          logger.error('Audio processing error', { error: err.message });
          reject(err);
        })
        .on('end', () => {
          onProgress?.(100, 'Complete');
          const outputBuffer = Buffer.concat(chunks);

          logger.info('Audio processed', {
            originalSize: input.length,
            outputSize: outputBuffer.length,
            sampleRate: sample_rate,
            channels,
            format,
          });

          resolve({
            buffer: outputBuffer,
            metadata: {
              originalSize: input.length,
              outputSize: outputBuffer.length,
              sampleRate: sample_rate,
              channels,
              format,
              mimeType: this.getMimeType(format),
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

  getMimeType(format) {
    const mimeTypes = {
      mp3: 'audio/mpeg',
      wav: 'audio/wav',
      ogg: 'audio/ogg',
      m4a: 'audio/mp4',
    };
    return mimeTypes[format] || 'audio/mpeg';
  }
}

export default AudioProcessor;
