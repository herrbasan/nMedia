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

const MIME_TYPES = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', mov: 'video/quicktime' };
const AUDIO_CODECS = { mp3: 'libmp3lame', wav: 'pcm_s16le', ogg: 'libvorbis', m4a: 'aac' };
const VIDEO_CODECS = { libx264: 'libx264', libx265: 'libx265', h264_nvenc: 'h264_nvenc', hevc_nvenc: 'hevc_nvenc', h264_vaapi: 'h264_vaapi', hevc_vaapi: 'hevc_vaapi', h264_qsv: 'h264_qsv', hevc_qsv: 'hevc_qsv' };
const CONTAINER_MAP = { mp4: 'mp4', webm: 'webm', mkv: 'mkv', mov: 'mov' };

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

    onProgress?.(5, `Starting video processing: ${mode}`);

    if (mode === 'extract_audio') {
      return this.extractAudio(input, options, onProgress);
    } else if (mode === 'extract_keyframes') {
      return this.extractKeyframes(input, options, onProgress);
    } else {
      return this.transcodeVideo(input, options, onProgress);
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

  async transcodeVideo(input, options, onProgress) {
    const {
      output_format = 'mp4',
      video_codec = 'libx264',
      audio_codec = 'aac',
      width,
      height,
      crf = 23,
      preset = 'medium',
      audio_bitrate = 128000,
      fps,
    } = options;

    const inputId = uuidv4();
    const outputId = uuidv4();
    const inputExt = this._detectInputExtension(input);
    const outputExt = CONTAINER_MAP[output_format] || output_format;
    const inputPath = path.join(config.cacheDir, `input-${inputId}.${inputExt}`);
    const outputPath = path.join(config.cacheDir, `output-${outputId}.${outputExt}`);

    try {
      onProgress?.(10, 'Preparing video');
      fs.writeFileSync(inputPath, input);

      onProgress?.(15, 'Probing source video');
      const probeResult = nVideo.probe(inputPath);
      const videoStream = probeResult.streams.find(s => s.type === 'video');
      const audioStream = probeResult.streams.find(s => s.type === 'audio');

      const sourceWidth = videoStream?.width;
      const sourceHeight = videoStream?.height;
      const sourceDuration = probeResult.format.duration;

      // Calculate dimensions - ensure even numbers for codecs
      let targetWidth = width;
      let targetHeight = height;
      if (targetWidth && !targetHeight) {
        targetHeight = Math.round(sourceHeight * (targetWidth / sourceWidth));
      } else if (targetHeight && !targetWidth) {
        targetWidth = Math.round(sourceWidth * (targetHeight / sourceHeight));
      }
      // Ensure even dimensions
      if (targetWidth) targetWidth = targetWidth % 2 === 0 ? targetWidth : targetWidth + 1;
      if (targetHeight) targetHeight = targetHeight % 2 === 0 ? targetHeight : targetHeight + 1;

      onProgress?.(20, `Transcoding: ${video_codec} → ${output_format}`);

      const transcodeOpts = {
        cache: false,
        onProgress: (p) => {
          const mappedPercent = 20 + Math.round(p.percent * 0.7);
          onProgress?.(mappedPercent, `Transcoding: ${Math.round(p.percent)}% (${p.speed?.toFixed(1) || '?'}x)`);
        },
        onComplete: (result) => {
          onProgress?.(95, 'Finalizing');
        },
        onError: (error) => {
          reject?.(new Error(error.message || 'nVideo transcode failed'));
        },
      };

      // Build video options
      const videoOpts = {
        codec: video_codec,
        crf,
        preset,
      };
      if (targetWidth) videoOpts.width = targetWidth;
      if (targetHeight) videoOpts.height = targetHeight;
      if (fps) videoOpts.fps = fps;
      transcodeOpts.video = videoOpts;

      // Build audio options
      if (audioStream) {
        transcodeOpts.audio = {
          codec: audio_codec,
          bitrate: audio_bitrate,
        };
      }

      await new Promise((resolve, reject) => {
        transcodeOpts.onComplete = (result) => {
          onProgress?.(95, 'Finalizing');
          resolve(result);
        };
        transcodeOpts.onError = (error) => {
          reject(new Error(error.message || 'nVideo transcode failed'));
        };
        nVideo.transcode(inputPath, outputPath, transcodeOpts);
      });

      onProgress?.(98, 'Reading output');
      const outputBuffer = fs.readFileSync(outputPath);

      try { fs.unlinkSync(inputPath); } catch {}
      try { fs.unlinkSync(outputPath); } catch {}

      onProgress?.(100, 'Complete');

      logger.info('Video transcoded', {
        originalSize: input.length,
        outputSize: outputBuffer.length,
        videoCodec,
        audioCodec,
        outputFormat,
        dimensions: targetWidth && targetHeight ? `${targetWidth}x${targetHeight}` : 'source',
      });

      return {
        buffer: outputBuffer,
        metadata: {
          originalSize: input.length,
          outputSize: outputBuffer.length,
          mode: 'transcode',
          outputFormat,
          videoCodec,
          audioCodec,
          dimensions: targetWidth && targetHeight ? `${targetWidth}x${targetHeight}` : `${sourceWidth}x${sourceHeight}`,
          duration: sourceDuration,
          mimeType: MIME_TYPES[output_format] || 'video/mp4',
        },
      };
    } catch (error) {
      try { fs.unlinkSync(inputPath); } catch {}
      try { fs.unlinkSync(outputPath); } catch {}

      logger.error('Video transcode error', { error: error.message });
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
