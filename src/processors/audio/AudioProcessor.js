import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from '../../utils/uuid.js';
import Processor from '../../pipeline/Processor.js';
import config from '../../config/config.js';
import logger from '../../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load nVideo from submodule (ESM compatibility via createRequire)
const nVideoPath = path.join(__dirname, '../../../modules/nVideo/lib/index.js');
const require = createRequire(import.meta.url);
const nVideo = require(nVideoPath);

const FORMAT_EXTENSIONS = { mp3: 'mp3', wav: 'wav', ogg: 'ogg', m4a: 'm4a', flac: 'flac', aac: 'aac', opus: 'opus' };
const MIME_TYPES = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac', aac: 'audio/aac', opus: 'audio/opus' };

// Audio codec mapping
const AUDIO_CODECS = { mp3: 'libmp3lame', wav: 'pcm_s16le', ogg: 'libvorbis', m4a: 'aac', flac: 'flac', aac: 'aac', opus: 'libopus' };

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
    if (format !== undefined && !['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac', 'opus'].includes(format)) {
      throw new Error('format must be mp3, wav, ogg, m4a, flac, aac, or opus');
    }
  }

  async probe(input) {
    let inputPath = null;
    let shouldCleanup = false;

    if (typeof input === 'string' && fs.existsSync(input)) {
      inputPath = input;
    } else if (Buffer.isBuffer(input)) {
      const inputId = uuidv4();
      const inputExt = this._detectInputExtension(input);
      inputPath = path.join(config.cacheDir, `probe-${inputId}.${inputExt}`);
      fs.writeFileSync(inputPath, input);
      shouldCleanup = true;
    } else {
      throw new Error('Invalid input for probe: must be file path or buffer');
    }

    try {
      const probeResult = nVideo.probe(inputPath);

      const audioStream = probeResult.streams.find(s => s.type === 'audio');
      if (!audioStream) {
        throw new Error('No audio stream found in file');
      }

      const result = {
        duration: probeResult.format.duration || null,
        bitrate: probeResult.format.bitrate || null,
        format: probeResult.format.name,
        sampleRate: audioStream.sampleRate || null,
        channels: audioStream.channels,
        channelLayout: audioStream.channelLayout,
        codec: audioStream.codec,
        bitDepth: audioStream.bitsPerSample || null,
      };

      logger.info('Audio probed', result);
      return result;
    } finally {
      if (shouldCleanup) { try { fs.unlinkSync(inputPath); } catch {} }
    }
  }

  async process(input, options = {}, onProgress) {
    const inputSource = options._inputSource || 'buffer';
    let inputPath = null;
    let shouldCleanupInput = false;

    // Resolve input path
    if (inputSource === 'path' && typeof input === 'string' && fs.existsSync(input)) {
      inputPath = input;
    } else if (Buffer.isBuffer(input)) {
      const inputId = uuidv4();
      const inputExt = this._detectInputExtension(input);
      inputPath = path.join(config.cacheDir, `input-${inputId}.${inputExt}`);
      fs.writeFileSync(inputPath, input);
      shouldCleanupInput = true;
    } else {
      throw new Error('Invalid audio input: must be file path or buffer');
    }

    let sourceMetadata;
    try {
      sourceMetadata = await this.probe(inputPath);
    } catch (err) {
      logger.warn('Failed to probe source audio, using defaults', { error: err.message });
      sourceMetadata = { sampleRate: 44100, channels: 2 };
    }

    const {
      sample_rate = 'source',
      channels = 'source',
      format = 'mp3',
      audio_bitrate,
    } = options;

    const targetSampleRate = sample_rate === 'source' ? sourceMetadata.sampleRate : sample_rate;
    const targetChannels = channels === 'source' ? sourceMetadata.channels : channels;

    const bitrate = audio_bitrate || (format === 'mp3' || format === 'm4a' ? 128000 : 0);

    const outputId = uuidv4();
    const outputExt = FORMAT_EXTENSIONS[format] || format;
    const outputPath = path.join(config.cacheDir, `output-${outputId}.${outputExt}`);

    const originalSize = fs.statSync(inputPath).size;

    try {
      onProgress?.(10, 'Processing audio');

      await new Promise((resolve, reject) => {
        nVideo.transcode(inputPath, outputPath, {
          audio: {
            codec: AUDIO_CODECS[format],
            sampleRate: targetSampleRate,
            channels: targetChannels,
            bitrate,
          },
          cache: false,
          onProgress: (p) => {
            const mappedPercent = 10 + Math.round(p.percent * 0.8);
            onProgress?.(mappedPercent, `Processing: ${Math.round(p.percent)}%`);
          },
          onComplete: (result) => {
            resolve(result);
          },
          onError: (error) => {
            reject(new Error(error.message || 'nVideo transcode failed'));
          },
        });
      });

      onProgress?.(90, 'Reading output');

      const outputBuffer = fs.readFileSync(outputPath);

      try { fs.unlinkSync(outputPath); } catch {}
      if (shouldCleanupInput) { try { fs.unlinkSync(inputPath); } catch {} }

      onProgress?.(100, 'Complete');

      logger.info('Audio processed', {
        originalSize,
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
          originalSize,
          outputSize: outputBuffer.length,
          sampleRate: targetSampleRate,
          channels: targetChannels,
          format,
          mimeType: MIME_TYPES[format] || 'audio/mpeg',
          sourceMetadata,
        },
      };
    } catch (error) {
      try { fs.unlinkSync(outputPath); } catch {}
      if (shouldCleanupInput) { try { fs.unlinkSync(inputPath); } catch {} }

      logger.error('Audio processing error', { error: error.message });
      throw error;
    }
  }

  _detectInputExtension(buffer) {
    if (buffer.length < 4) return 'bin';

    const magic = buffer.slice(0, 4).toString('hex').toUpperCase();

    if (magic.startsWith('494433') || magic.startsWith('FFE')) return 'mp3';
    if (magic.startsWith('52494646')) return 'wav';
    if (magic.startsWith('4F676753')) return 'ogg';
    if (buffer.slice(4, 8).toString('hex').toUpperCase() === '66747970') return 'm4a';
    if (magic.startsWith('664C6143')) return 'flac';

    return 'bin';
  }
}

export default AudioProcessor;
