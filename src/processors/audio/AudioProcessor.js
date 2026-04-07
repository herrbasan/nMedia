import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from '../../utils/uuid.js';
import Processor from '../../pipeline/Processor.js';
import config from '../../config/config.js';
import logger from '../../utils/logger.js';
import { processAudio, FORMAT_EXTENSIONS, MIME_TYPES } from '../../utils/ffmpeg/index.js';

/**
 * Audio processor using FFmpeg CLI wrapper
 * Processes audio files with file-based I/O for reliability
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

  async process(input, options = {}, onProgress) {
    const {
      sample_rate = 16000,
      channels = 1,
      format = 'mp3',
    } = options;

    const inputId = uuidv4();
    const outputId = uuidv4();
    
    const inputExt = this._detectInputExtension(input);
    const inputPath = path.join(config.cacheDir, `input-${inputId}.${inputExt}`);
    const outputExt = FORMAT_EXTENSIONS[format] || format;
    const outputPath = path.join(config.cacheDir, `output-${outputId}.${outputExt}`);

    try {
      onProgress?.(5, 'Preparing audio');

      // Write input buffer to temp file
      fs.writeFileSync(inputPath, input);
      
      onProgress?.(10, 'Processing audio');

      // Process with FFmpeg
      const result = await processAudio({
        inputPath,
        outputPath,
        format,
        sampleRate: sample_rate,
        channels,
        onProgress: (percent, metadata) => {
          // Map FFmpeg progress (0-100) to our range (10-90)
          const mappedPercent = 10 + Math.round(percent * 0.8);
          onProgress?.(mappedPercent, `Processing: ${Math.round(percent)}%`);
        },
      });

      onProgress?.(90, 'Reading output');

      // Read output file
      const outputBuffer = fs.readFileSync(outputPath);

      // Clean up input file immediately
      try {
        fs.unlinkSync(inputPath);
      } catch (err) {
        logger.debug('Failed to clean up input file', { error: err.message });
      }

      // Clean up output file (caller will cache it)
      try {
        fs.unlinkSync(outputPath);
      } catch (err) {
        logger.debug('Failed to clean up output file', { error: err.message });
      }

      onProgress?.(100, 'Complete');

      logger.info('Audio processed', {
        originalSize: input.length,
        outputSize: outputBuffer.length,
        sampleRate: sample_rate,
        channels,
        format,
      });

      return {
        buffer: outputBuffer,
        metadata: {
          originalSize: input.length,
          outputSize: outputBuffer.length,
          sampleRate: sample_rate,
          channels,
          format,
          mimeType: this.getMimeType(format),
        },
      };
    } catch (error) {
      // Clean up temp files on error
      try { fs.unlinkSync(inputPath); } catch {}
      try { fs.unlinkSync(outputPath); } catch {}
      
      logger.error('Audio processing error', { error: error.message });
      throw error;
    }
  }

  /**
   * Detect input file extension from buffer magic bytes
   * @param {Buffer} buffer
   * @returns {string}
   */
  _detectInputExtension(buffer) {
    // Check magic bytes for common formats
    if (buffer.length < 4) return 'bin';
    
    const magic = buffer.slice(0, 4).toString('hex').toUpperCase();
    
    // MP3 (ID3 tag or MPEG sync)
    if (magic.startsWith('494433') || magic.startsWith('FFE')) return 'mp3';
    
    // WAV (RIFF....WAVE)
    if (magic.startsWith('52494646')) return 'wav';
    
    // OGG
    if (magic.startsWith('4F676753')) return 'ogg';
    
    // M4A/AAC (ftyp)
    if (buffer.slice(4, 8).toString('hex').toUpperCase() === '66747970') return 'm4a';
    
    // FLAC
    if (magic.startsWith('664C6143')) return 'flac';
    
    return 'bin';
  }

  getMimeType(format) {
    return MIME_TYPES[format] || 'audio/mpeg';
  }
}

export default AudioProcessor;
