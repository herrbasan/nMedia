import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';
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

// Load nImage for RGB→JPEG conversion of thumbnails
const nImagePath = path.join(__dirname, '../../../modules/nImage/lib/index.js');
const nImageUrl = pathToFileURL(nImagePath).href;
let nImage;
try {
  nImage = (await import(nImageUrl)).default;
} catch (e) {
  throw new Error(`nImage module not found. Error: ${e.message}`);
}

const MIME_TYPES = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4' };
const AUDIO_CODECS = { mp3: 'libmp3lame', wav: 'pcm_s16le', ogg: 'libvorbis', m4a: 'aac' };

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

  async process(input, options = {}, onProgress) {
    const { mode = 'extract_audio' } = options;

    onProgress?.(5, `Starting video processing: ${mode}`);

    if (mode === 'extract_audio') {
      return this.extractAudio(input, options, onProgress);
    } else {
      return this.extractKeyframes(input, options, onProgress);
    }
  }

  async extractAudio(input, options, onProgress) {
    const { format = 'mp3' } = options;

    const inputId = uuidv4();
    const outputId = uuidv4();

    const inputExt = this._detectInputExtension(input);
    const inputPath = path.join(config.cacheDir, `input-${inputId}.${inputExt}`);
    const outputPath = path.join(config.cacheDir, `output-${outputId}.${format}`);

    try {
      onProgress?.(10, 'Preparing video');
      fs.writeFileSync(inputPath, input);

      onProgress?.(15, 'Extracting audio track');

      await new Promise((resolve, reject) => {
        nVideo.extractAudio(inputPath, outputPath, {
          codec: AUDIO_CODECS[format],
          bitrate: 128000,
          cache: false,
          onProgress: (p) => {
            const mappedPercent = 15 + Math.round(p.percent * 0.75);
            onProgress?.(mappedPercent, `Extracting: ${Math.round(p.percent)}%`);
          },
          onComplete: (result) => {
            resolve(result);
          },
          onError: (error) => {
            reject(new Error(error.message || 'nVideo extractAudio failed'));
          },
        });
      });

      onProgress?.(90, 'Reading output');

      const outputBuffer = fs.readFileSync(outputPath);

      try { fs.unlinkSync(inputPath); } catch {}
      try { fs.unlinkSync(outputPath); } catch {}

      onProgress?.(100, 'Complete');

      logger.info('Audio extracted from video', {
        originalSize: input.length,
        outputSize: outputBuffer.length,
      });

      return {
        buffer: outputBuffer,
        metadata: {
          originalSize: input.length,
          outputSize: outputBuffer.length,
          mode: 'extract_audio',
          format,
          mimeType: MIME_TYPES[format] || 'audio/mpeg',
        },
      };
    } catch (error) {
      try { fs.unlinkSync(inputPath); } catch {}
      try { fs.unlinkSync(outputPath); } catch {}

      logger.error('Video audio extraction error', { error: error.message });
      throw error;
    }
  }

  async extractKeyframes(input, options, onProgress) {
    const { fps = 1, max_dimension = 1024 } = options;

    const inputId = uuidv4();
    const outputId = uuidv4();

    const inputExt = this._detectInputExtension(input);
    const inputPath = path.join(config.cacheDir, `input-${inputId}.${inputExt}`);

    try {
      onProgress?.(10, 'Preparing video');
      fs.writeFileSync(inputPath, input);

      // Probe to get duration and video stream info
      onProgress?.(15, `Extracting keyframes at ${fps} fps`);
      const probeResult = nVideo.probe(inputPath);
      const videoStream = probeResult.streams.find(s => s.type === 'video');
      if (!videoStream) {
        throw new Error('No video stream found in file');
      }

      const duration = probeResult.format.duration;
      const frameWidth = Math.min(max_dimension, videoStream.width);
      const frameInterval = 1 / fps;
      const frameCount = Math.floor(duration * fps);

      const frames = [];
      for (let i = 0; i < frameCount; i++) {
        const timestamp = i * frameInterval;
        const progress = 15 + Math.round((i / frameCount) * 70);
        onProgress?.(progress, `Extracted ${i + 1}/${frameCount} frames`);

        const thumb = nVideo.thumbnail(inputPath, {
          timestamp,
          width: frameWidth,
        });

        // thumb is { width, height, data: Uint8Array } in RGB24 format
        const jpegBuffer = await this._rgbToJpeg(thumb.data, thumb.width, thumb.height);
        frames.push(jpegBuffer);
      }

      onProgress?.(85, 'Collecting frames');

      // Return first frame as buffer (matching current API)
      const firstFrame = frames.length > 0 ? frames[0] : Buffer.alloc(0);

      try { fs.unlinkSync(inputPath); } catch {}

      onProgress?.(100, 'Complete');

      logger.info('Keyframes extracted from video', {
        originalSize: input.length,
        frameCount: frames.length,
        outputSize: firstFrame.length,
      });

      return {
        buffer: firstFrame,
        metadata: {
          originalSize: input.length,
          frameCount: frames.length,
          mode: 'extract_keyframes',
          format: 'jpeg',
          fps,
          maxDimension: max_dimension,
          mimeType: 'image/jpeg',
        },
        frames, // All frames available for future use
      };
    } catch (error) {
      try { fs.unlinkSync(inputPath); } catch {}

      logger.error('Video keyframe extraction error', { error: error.message });
      throw error;
    }
  }

  async _rgbToJpeg(rgbData, width, height) {
    // nVideo thumbnail returns RGB24 data, convert to JPEG using nImage
    // nImage expects ImageData-like object: { data, width, height, channels }
    return await nImage({
      data: rgbData,
      width,
      height,
      channels: 3
    }).jpeg({ quality: 85 }).toBuffer();
  }

  _detectInputExtension(buffer) {
    if (buffer.length < 12) return 'bin';

    const magic = buffer.slice(0, 12).toString('hex').toUpperCase();

    if (buffer.slice(4, 8).toString('hex').toUpperCase() === '66747970') {
      const brand = buffer.slice(8, 12).toString('ascii');
      if (brand.startsWith('qt')) return 'mov';
      return 'mp4';
    }

    if (magic.startsWith('1A45DFA3')) return 'webm';
    if (magic.startsWith('52494646') && magic.includes('41564920')) return 'avi';
    if (buffer.slice(4, 10).toString('ascii') === 'ftypqt') return 'mov';

    return 'bin';
  }
}

export default VideoProcessor;
