import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from '../../utils/uuid.js';
import Processor from '../../pipeline/Processor.js';
import config from '../../config/config.js';
import logger from '../../utils/logger.js';
import { processAudio, FORMAT_EXTENSIONS, MIME_TYPES } from '../../utils/ffmpeg/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Get ffprobe path
 */
function getFfprobePath() {
  // ffprobe is usually next to ffmpeg
  if (config.ffmpegPath) {
    return config.ffmpegPath.replace('ffmpeg', 'ffprobe');
  }
  return 'ffprobe';
}

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

    if (sample_rate !== undefined && sample_rate !== 'source' && ![8000, 16000, 22050, 44100, 48000].includes(sample_rate)) {
      throw new Error('sample_rate must be 8000, 16000, 22050, 44100, 48000, or "source"');
    }
    if (channels !== undefined && channels !== 'source' && ![1, 2].includes(channels)) {
      throw new Error('channels must be 1 (mono), 2 (stereo), or "source"');
    }
    if (format !== undefined && !['mp3', 'wav', 'ogg', 'm4a'].includes(format)) {
      throw new Error('format must be mp3, wav, ogg, or m4a');
    }
  }

  /**
   * Probe audio file to extract metadata
   * @param {Buffer} input - Audio buffer
   * @returns {Promise<Object>} - Audio metadata
   */
  async probe(input) {
    const inputId = uuidv4();
    const inputExt = this._detectInputExtension(input);
    const inputPath = path.join(config.cacheDir, `probe-${inputId}.${inputExt}`);

    try {
      // Write input buffer to temp file
      fs.writeFileSync(inputPath, input);

      const ffprobePath = getFfprobePath();
      
      const result = await new Promise((resolve, reject) => {
        const proc = spawn(ffprobePath, [
          '-v', 'quiet',
          '-print_format', 'json',
          '-show_format',
          '-show_streams',
          inputPath
        ], { stdio: ['ignore', 'pipe', 'pipe'] });

        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (data) => {
          stdout += data.toString();
        });

        proc.stderr.on('data', (data) => {
          stderr += data.toString();
        });

        proc.on('close', (code) => {
          if (code === 0) {
            try {
              const metadata = JSON.parse(stdout);
              const audioStream = metadata.streams.find(s => s.codec_type === 'audio');
              
              if (!audioStream) {
                reject(new Error('No audio stream found in file'));
                return;
              }

              console.log('=== FFPROBE AUDIO STREAM ===');
              console.log(JSON.stringify(audioStream, null, 2));
              console.log('============================');

              resolve({
                duration: metadata.format.duration ? parseFloat(metadata.format.duration) : null,
                bitrate: metadata.format.bit_rate ? parseInt(metadata.format.bit_rate) : null,
                format: metadata.format.format_name,
                sampleRate: audioStream.sample_rate ? parseInt(audioStream.sample_rate) : null,
                channels: audioStream.channels,
                channelLayout: audioStream.channel_layout,
                codec: audioStream.codec_name,
                bitDepth: audioStream.bits_per_sample || audioStream.bits_per_raw_sample || null,
              });
            } catch (err) {
              reject(new Error(`Failed to parse ffprobe output: ${err.message}`));
            }
          } else {
            reject(new Error(`ffprobe exited with code ${code}: ${stderr}`));
          }
        });

        proc.on('error', (err) => {
          reject(new Error(`Failed to start ffprobe: ${err.message}`));
        });
      });

      // Clean up
      try { fs.unlinkSync(inputPath); } catch {}

      logger.info('Audio probed', result);
      return result;
    } catch (error) {
      // Clean up on error
      try { fs.unlinkSync(inputPath); } catch {}
      throw error;
    }
  }

  async process(input, options = {}, onProgress) {
    // First probe the source to get metadata
    let sourceMetadata;
    try {
      sourceMetadata = await this.probe(input);
    } catch (err) {
      logger.warn('Failed to probe source audio, using defaults', { error: err.message });
      sourceMetadata = { sampleRate: 44100, channels: 2 };
    }

    const {
      sample_rate = 16000,
      channels = 1,
      format = 'mp3',
    } = options;

    // Use source values if 'source' is specified
    const targetSampleRate = sample_rate === 'source' ? sourceMetadata.sampleRate : sample_rate;
    const targetChannels = channels === 'source' ? sourceMetadata.channels : channels;

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
        sampleRate: targetSampleRate,
        channels: targetChannels,
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
        sourceSampleRate: sourceMetadata.sampleRate,
        sourceChannels: sourceMetadata.channels,
        targetSampleRate,
        targetChannels,
        format,
      });

      return {
        buffer: outputBuffer,
        metadata: {
          originalSize: input.length,
          outputSize: outputBuffer.length,
          sampleRate: targetSampleRate,
          channels: targetChannels,
          format,
          mimeType: this.getMimeType(format),
          sourceMetadata,
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
