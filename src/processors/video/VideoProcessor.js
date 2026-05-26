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

const MIME_TYPES = {
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4',
  flac: 'audio/flac', aac: 'audio/aac', opus: 'audio/opus',
  mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska',
  mov: 'video/quicktime', avi: 'video/avi', ts: 'video/mp2t',
};

const AUDIO_CODECS = {
  mp3: 'libmp3lame', wav: 'pcm_s16le', ogg: 'libvorbis', m4a: 'aac',
  flac: 'flac', aac: 'aac', opus: 'libopus',
};

const DEFAULT_TRANSCODE_CLI = '-c:v libx264 -crf 23 -preset medium -c:a aac -b:a 128k';

class VideoProcessor extends Processor {
  constructor() {
    super('video');
  }

  validateOptions(options) {
    const { mode, fps } = options;
    if (mode !== undefined && !['extract_audio', 'extract_keyframes', 'transcode'].includes(mode)) {
      throw new Error('mode must be extract_audio, extract_keyframes, or transcode');
    }
    if (fps !== undefined && (fps < 1 || fps > 30)) {
      throw new Error('fps must be between 1 and 30');
    }
  }

  async process(input, options = {}, onProgress) {
    const { mode = 'extract_audio' } = options;
    const originalSize = Buffer.isBuffer(input) ? input.length : null;

    const { inputPath, shouldCleanup } = this._resolveInput(input);

    try {
      if (mode === 'extract_audio') {
        return await this._extractAudio(inputPath, options, onProgress, originalSize);
      }
      if (mode === 'extract_keyframes') {
        return await this._extractKeyframes(inputPath, options, onProgress, originalSize);
      }
      return await this._transcode(inputPath, options, onProgress, originalSize);
    } finally {
      if (shouldCleanup) {
        try { fs.unlinkSync(inputPath); } catch {}
      }
    }
  }

  // --------------------------------------------------------------------------
  // Transcode — FFmpeg CLI only
  // --------------------------------------------------------------------------
  async _transcode(inputPath, options, onProgress, originalSize) {
    const cliCommand = options.cli_command || DEFAULT_TRANSCODE_CLI;
    const outputExt = path.extname(inputPath).slice(1) || 'mp4';
    const outputId = uuidv4();
    const outputPath = path.join(config.cacheDir, `output-${outputId}.${outputExt}`);

    onProgress?.(5, 'Starting transcode');

    await this._runFfmpeg(inputPath, outputPath, cliCommand, onProgress);

    const stat = fs.statSync(outputPath);
    onProgress?.(100, 'Complete');

    logger.info('Video transcoded', {
      inputPath,
      outputPath,
      outputSize: stat.size,
      cliCommand,
    });

    return {
      filePath: outputPath,
      metadata: {
        outputSize: stat.size,
        mode: 'transcode',
        mimeType: MIME_TYPES[outputExt] || 'video/mp4',
        originalSize,
      },
    };
  }

  // --------------------------------------------------------------------------
  // Extract Audio — FFmpeg CLI
  // --------------------------------------------------------------------------
  async _extractAudio(inputPath, options, onProgress, originalSize) {
    const format = options.format || 'mp3';
    const codec = AUDIO_CODECS[format];
    if (!codec) {
      throw new Error(`Unsupported audio format: ${format}`);
    }

    const bitrate = options.audio_bitrate || 128000;
    const brK = Math.floor(bitrate / 1000);
    const cliCommand = `-vn -c:a ${codec} -b:a ${brK}k`;

    const outputId = uuidv4();
    const outputPath = path.join(config.cacheDir, `output-${outputId}.${format}`);

    onProgress?.(5, 'Extracting audio track');

    await this._runFfmpeg(inputPath, outputPath, cliCommand, onProgress);

    const stat = fs.statSync(outputPath);
    onProgress?.(100, 'Complete');

    logger.info('Audio extracted from video', {
      inputPath,
      outputPath,
      outputSize: stat.size,
      format,
    });

    // Read output into buffer for buffer-based workflows
    const outputBuffer = fs.readFileSync(outputPath);
    try { fs.unlinkSync(outputPath); } catch {}

    return {
      buffer: outputBuffer,
      metadata: {
        outputSize: stat.size,
        mode: 'extract_audio',
        format,
        mimeType: MIME_TYPES[format] || 'audio/mpeg',
        originalSize,
      },
    };
  }

  // --------------------------------------------------------------------------
  // Extract Keyframes — native thumbnail loop + nImage JPEG
  // --------------------------------------------------------------------------
  async _extractKeyframes(inputPath, options, onProgress, originalSize) {
    const { fps = 1, max_dimension = 1024 } = options;

    onProgress?.(10, `Extracting keyframes at ${fps} fps`);

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
      const progress = 10 + Math.round((i / frameCount) * 80);
      onProgress?.(progress, `Extracted ${i + 1}/${frameCount} frames`);

      const thumb = nVideo.thumbnail(inputPath, { timestamp, width: frameWidth });
      const jpegBuffer = await this._rgbToJpeg(thumb.data, thumb.width, thumb.height);
      frames.push(jpegBuffer);
    }

    onProgress?.(95, 'Collecting frames');

    const firstFrame = frames.length > 0 ? frames[0] : Buffer.alloc(0);

    onProgress?.(100, 'Complete');

    logger.info('Keyframes extracted from video', {
      inputPath,
      frameCount: frames.length,
      outputSize: firstFrame.length,
    });

    return {
      buffer: firstFrame,
      metadata: {
        frameCount: frames.length,
        mode: 'extract_keyframes',
        format: 'jpeg',
        fps,
        maxDimension: max_dimension,
        mimeType: 'image/jpeg',
        originalSize,
      },
      frames,
    };
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------
  _resolveInput(input) {
    if (Buffer.isBuffer(input)) {
      const inputId = uuidv4();
      const inputExt = this._detectInputExtension(input);
      const inputPath = path.join(config.cacheDir, `input-${inputId}.${inputExt}`);
      fs.writeFileSync(inputPath, input);
      return { inputPath, shouldCleanup: true };
    }
    if (typeof input === 'string' && fs.existsSync(input)) {
      return { inputPath: input, shouldCleanup: false };
    }
    throw new Error('Invalid input: must be a Buffer or an existing file path');
  }

  _runFfmpeg(inputPath, outputPath, cliCommand, onProgress) {
    return new Promise((resolve, reject) => {
      nVideo.transcode(inputPath, outputPath, {
        cli_command: cliCommand,
        cache: false,
        onProgress: (p) => {
          const msg = p.speed
            ? `Processing: ${Math.round(p.percent)}% (${p.speed.toFixed(1)}x)`
            : `Processing: ${Math.round(p.percent)}%`;
          onProgress?.(p.percent, msg);
        },
        onComplete: (result) => resolve(result),
        onError: (error) => reject(new Error(error.message || 'FFmpeg processing failed')),
      });
    });
  }

  async _rgbToJpeg(rgbData, width, height) {
    return await nImage({
      data: rgbData,
      width,
      height,
      channels: 3,
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
