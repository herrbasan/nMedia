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

const FORMAT_EXTENSIONS = { mp3: 'mp3', wav: 'wav', ogg: 'ogg', m4a: 'm4a' };
const MIME_TYPES = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4' };

// Audio codec mapping
const AUDIO_CODECS = { mp3: 'libmp3lame', wav: 'pcm_s16le', ogg: 'libvorbis', m4a: 'aac' };

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

  async probe(input) {
    const inputId = uuidv4();
    const inputExt = this._detectInputExtension(input);
    const inputPath = path.join(config.cacheDir, `probe-${inputId}.${inputExt}`);

    try {
      fs.writeFileSync(inputPath, input);

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
      try { fs.unlinkSync(inputPath); } catch {}
    }
  }

  async process(input, options = {}, onProgress) {
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
      fs.writeFileSync(inputPath, input);

      onProgress?.(10, 'Processing audio');

      await new Promise((resolve, reject) => {
        nVideo.transcode(inputPath, outputPath, {
          audio: {
            codec: AUDIO_CODECS[format],
            sampleRate: targetSampleRate,
            channels: targetChannels,
            bitrate: format === 'mp3' || format === 'm4a' ? 128000 : 0,
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

      try { fs.unlinkSync(inputPath); } catch {}
      try { fs.unlinkSync(outputPath); } catch {}

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
          mimeType: MIME_TYPES[format] || 'audio/mpeg',
          sourceMetadata,
        },
      };
    } catch (error) {
      try { fs.unlinkSync(inputPath); } catch {}
      try { fs.unlinkSync(outputPath); } catch {}

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
