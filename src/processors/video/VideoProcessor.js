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
    const { mode = 'extract_audio', input_path, output_path, _inputSource } = options;

    // File-to-file workflow (explicit paths)
    if (input_path && output_path) {
      return this.processFileToFile(input_path, output_path, options, onProgress);
    }

    // Path-based input (from Worker resolving input_path or fileId)
    if (_inputSource === 'path' && typeof input === 'string' && fs.existsSync(input)) {
      onProgress?.(5, `Starting video processing: ${mode}`);

      const inputStat = fs.statSync(input);

      if (mode === 'extract_audio') {
        return this._extractAudioToBuffer(input, options, onProgress, inputStat.size);
      } else if (mode === 'extract_keyframes') {
        return this._extractKeyframesFromPath(input, options, onProgress, inputStat.size);
      } else {
        return this._transcodePathToBuffer(input, options, onProgress, inputStat.size);
      }
    }

    // Buffer-based workflow (legacy upload)
    onProgress?.(5, `Starting video processing: ${mode}`);

    if (mode === 'extract_audio') {
      return this.extractAudio(input, options, onProgress);
    } else if (mode === 'extract_keyframes') {
      return this.extractKeyframes(input, options, onProgress);
    } else {
      return this.transcodeVideo(input, options, onProgress);
    }
  }

  /**
   * File-to-file processing - no buffer loading
   * @param {string} inputPath - Absolute path to input file
   * @param {string} outputPath - Absolute path to output file
   * @param {Object} options - Processing options
   * @param {Function} onProgress - Progress callback
   */
  async processFileToFile(inputPath, outputPath, options, onProgress) {
    const { mode = 'extract_audio' } = options;

    if (!fs.existsSync(inputPath)) {
      throw new Error(`Input file not found: ${inputPath}`);
    }

    const outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const inputStat = fs.statSync(inputPath);
    onProgress?.(5, `File-to-file: ${mode}`);

    if (mode === 'extract_audio') {
      return this._extractAudioFromFile(inputPath, outputPath, options, onProgress, inputStat.size);
    } else if (mode === 'transcode') {
      return this._transcodeFileToFile(inputPath, outputPath, options, onProgress, inputStat.size);
    } else {
      throw new Error(`File-to-file mode '${mode}' not supported. Use 'extract_audio' or 'transcode'.`);
    }
  }

  async _extractAudioToBuffer(inputPath, options, onProgress, inputSize) {
    const { format = 'mp3' } = options;
    const outputId = uuidv4();
    const outputPath = path.join(config.cacheDir, `output-${outputId}.${format}`);

    try {
      onProgress?.(10, 'Extracting audio track');

      await new Promise((resolve, reject) => {
        nVideo.extractAudio(inputPath, outputPath, {
          codec: AUDIO_CODECS[format],
          bitrate: 128000,
          cache: false,
          onProgress: (p) => {
            const mappedPercent = Math.min(95, 10 + Math.round(Math.min(100, p.percent) * 0.8));
            onProgress?.(mappedPercent, `Extracting: ${Math.round(Math.min(100, p.percent))}%`);
          },
          onComplete: (result) => resolve(result),
          onError: (error) => reject(new Error(error.message || 'nVideo extractAudio failed')),
        });
      });

      const outputBuffer = fs.readFileSync(outputPath);
      try { fs.unlinkSync(outputPath); } catch {}

      onProgress?.(100, 'Complete');

      return {
        buffer: outputBuffer,
        metadata: {
          originalSize: inputSize,
          outputSize: outputBuffer.length,
          mode: 'extract_audio',
          format,
          mimeType: MIME_TYPES[format] || 'audio/mpeg',
        },
      };
    } catch (error) {
      try { fs.unlinkSync(outputPath); } catch {}
      throw error;
    }
  }

  async _extractAudioFromFile(inputPath, outputPath, options, onProgress, inputSize) {
    const { format = 'mp3' } = options;

    onProgress?.(10, 'Extracting audio track');

    await new Promise((resolve, reject) => {
      nVideo.extractAudio(inputPath, outputPath, {
        codec: AUDIO_CODECS[format],
        bitrate: 128000,
        cache: false,
        onProgress: (p) => {
          const mappedPercent = Math.min(95, 10 + Math.round(Math.min(100, p.percent) * 0.8));
          onProgress?.(mappedPercent, `Extracting: ${Math.round(Math.min(100, p.percent))}%`);
        },
        onComplete: (result) => resolve(result),
        onError: (error) => reject(new Error(error.message || 'nVideo extractAudio failed')),
      });
    });

    const outputStat = fs.statSync(outputPath);

    onProgress?.(100, 'Complete');

    logger.info('Audio extracted from video (file-to-file)', {
      inputPath,
      outputPath,
      inputSize,
      outputSize: outputStat.size,
    });

    return {
      outputPath,
      metadata: {
        originalSize: inputSize,
        outputSize: outputStat.size,
        mode: 'extract_audio',
        format,
        mimeType: MIME_TYPES[format] || 'audio/mpeg',
      },
    };
  }

  async _extractKeyframesFromPath(inputPath, options, onProgress, inputSize) {
    const { fps = 1, max_dimension = 1024 } = options;

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

      const jpegBuffer = await this._rgbToJpeg(thumb.data, thumb.width, thumb.height);
      frames.push(jpegBuffer);
    }

    onProgress?.(85, 'Collecting frames');

    const firstFrame = frames.length > 0 ? frames[0] : Buffer.alloc(0);

    onProgress?.(100, 'Complete');

    return {
      buffer: firstFrame,
      metadata: {
        originalSize: inputSize,
        frameCount: frames.length,
        mode: 'extract_keyframes',
        format: 'jpeg',
        fps,
        maxDimension: max_dimension,
        mimeType: 'image/jpeg',
      },
      frames,
    };
  }

  async _transcodePathToBuffer(inputPath, options, onProgress, inputSize) {
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

    onProgress?.(15, 'Probing source video');
    const probeResult = nVideo.probe(inputPath);
    const videoStream = probeResult.streams.find(s => s.type === 'video');
    const audioStream = probeResult.streams.find(s => s.type === 'audio');

    const sourceWidth = videoStream?.width;
    const sourceHeight = videoStream?.height;
    const sourceDuration = probeResult.format.duration;

    let targetWidth = width;
    let targetHeight = height;

    // Apply max_dimension if no explicit width/height set
    const maxDim = options.max_dimension;
    if (!targetWidth && !targetHeight && maxDim && maxDim > 0) {
      const sourceLongEdge = Math.max(sourceWidth, sourceHeight);
      if (sourceLongEdge > maxDim) {
        const scale = maxDim / sourceLongEdge;
        targetWidth = Math.round(sourceWidth * scale);
        targetHeight = Math.round(sourceHeight * scale);
      }
    }

    if (targetWidth && !targetHeight) {
      targetHeight = Math.round(sourceHeight * (targetWidth / sourceWidth));
    } else if (targetHeight && !targetWidth) {
      targetWidth = Math.round(sourceWidth * (targetHeight / sourceHeight));
    }
    if (targetWidth) targetWidth = targetWidth % 2 === 0 ? targetWidth : targetWidth + 1;
    if (targetHeight) targetHeight = targetHeight % 2 === 0 ? targetHeight : targetHeight + 1;

    const outputId = uuidv4();
    const outputExt = CONTAINER_MAP[output_format] || output_format;
    const outputPath = path.join(config.cacheDir, `output-${outputId}.${outputExt}`);

    try {
      onProgress?.(20, `Transcoding: ${video_codec} → ${output_format}`);

      const isNvenc = video_codec && video_codec.includes('nvenc');
      const transcodeOpts = {
        cache: false,
        video: {
          codec: video_codec,
        },
      };
      if (isNvenc) {
        const presetMap = { ultrafast: 'p1', superfast: 'p2', veryfast: 'p3', faster: 'p4', fast: 'p5', medium: 'p4', slow: 'p6', slower: 'p7', veryslow: 'p7' };
        transcodeOpts.video.preset = presetMap[preset] || preset;
        transcodeOpts.video.cq = crf;
      } else {
        transcodeOpts.video.preset = preset;
        transcodeOpts.video.crf = crf;
      }
      if (targetWidth) transcodeOpts.video.width = targetWidth;
      if (targetHeight) transcodeOpts.video.height = targetHeight;
      if (fps) transcodeOpts.video.fps = fps;

      if (audioStream) {
        transcodeOpts.audio = {
          codec: audio_codec,
          bitrate: audio_bitrate,
        };
      }

      await new Promise((resolve, reject) => {
        transcodeOpts.onProgress = (p) => {
          const mappedPercent = Math.min(95, 20 + Math.round(Math.min(100, p.percent) * 0.7));
          onProgress?.(mappedPercent, `Transcoding: ${Math.round(Math.min(100, p.percent))}%`);
        };
        transcodeOpts.onComplete = (result) => resolve(result);
        transcodeOpts.onError = (error) => reject(new Error(error.message || 'nVideo transcode failed'));
        nVideo.transcode(inputPath, outputPath, transcodeOpts);
      });

      const outputBuffer = fs.readFileSync(outputPath);
      try { fs.unlinkSync(outputPath); } catch {}

      onProgress?.(100, 'Complete');

      return {
        buffer: outputBuffer,
        metadata: {
          originalSize: inputSize,
          outputSize: outputBuffer.length,
          mode: 'transcode',
          output_format,
          video_codec,
          audio_codec,
          dimensions: targetWidth && targetHeight ? `${targetWidth}x${targetHeight}` : `${sourceWidth}x${sourceHeight}`,
          duration: sourceDuration,
          mimeType: MIME_TYPES[output_format] || 'video/mp4',
        },
      };
    } catch (error) {
      try { fs.unlinkSync(outputPath); } catch {}
      throw error;
    }
  }

  async _transcodeFileToFile(inputPath, outputPath, options, onProgress, inputSize) {
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

    onProgress?.(10, 'Probing source video');
    const probeResult = nVideo.probe(inputPath);
    const videoStream = probeResult.streams.find(s => s.type === 'video');
    const audioStream = probeResult.streams.find(s => s.type === 'audio');

    const sourceWidth = videoStream?.width;
    const sourceHeight = videoStream?.height;
    const sourceDuration = probeResult.format.duration;

    let targetWidth = width;
    let targetHeight = height;

    // Apply max_dimension if no explicit width/height set
    const maxDim = options.max_dimension;
    if (!targetWidth && !targetHeight && maxDim && maxDim > 0) {
      const sourceLongEdge = Math.max(sourceWidth, sourceHeight);
      if (sourceLongEdge > maxDim) {
        const scale = maxDim / sourceLongEdge;
        targetWidth = Math.round(sourceWidth * scale);
        targetHeight = Math.round(sourceHeight * scale);
      }
    }

    if (targetWidth && !targetHeight) {
      targetHeight = Math.round(sourceHeight * (targetWidth / sourceWidth));
    } else if (targetHeight && !targetWidth) {
      targetWidth = Math.round(sourceWidth * (targetHeight / sourceHeight));
    }
    if (targetWidth) targetWidth = targetWidth % 2 === 0 ? targetWidth : targetWidth + 1;
    if (targetHeight) targetHeight = targetHeight % 2 === 0 ? targetHeight : targetHeight + 1;

    onProgress?.(15, `Transcoding: ${video_codec} → ${output_format}`);

    const isNvenc = video_codec && video_codec.includes('nvenc');
    const transcodeOpts = {
      cache: false,
      video: {
        codec: video_codec,
      },
    };
    if (isNvenc) {
      // NVENC uses p1-p7 presets and cq (not crf)
      const presetMap = { ultrafast: 'p1', superfast: 'p2', veryfast: 'p3', faster: 'p4', fast: 'p5', medium: 'p4', slow: 'p6', slower: 'p7', veryslow: 'p7' };
      transcodeOpts.video.preset = presetMap[preset] || preset;
      transcodeOpts.video.cq = crf;
    } else {
      transcodeOpts.video.preset = preset;
      transcodeOpts.video.crf = crf;
    }
    if (targetWidth) transcodeOpts.video.width = targetWidth;
    if (targetHeight) transcodeOpts.video.height = targetHeight;
    if (fps) transcodeOpts.video.fps = fps;

    if (audioStream) {
      transcodeOpts.audio = {
        codec: audio_codec,
        bitrate: audio_bitrate,
      };
    }

      await new Promise((resolve, reject) => {
        transcodeOpts.onProgress = (p) => {
          const mappedPercent = Math.min(95, 15 + Math.round(Math.min(100, p.percent) * 0.75));
          onProgress?.(mappedPercent, `Transcoding: ${Math.round(Math.min(100, p.percent))}% (${p.speed?.toFixed(1) || '?'}x)`);
        };
      transcodeOpts.onComplete = (result) => resolve(result);
      transcodeOpts.onError = (error) => reject(new Error(error.message || 'nVideo transcode failed'));
      nVideo.transcode(inputPath, outputPath, transcodeOpts);
    });

    const outputStat = fs.statSync(outputPath);

    onProgress?.(100, 'Complete');

    logger.info('Video transcoded (file-to-file)', {
      inputPath,
      outputPath,
      inputSize,
      outputSize: outputStat.size,
      video_codec,
      audio_codec,
      output_format,
    });

    return {
      outputPath,
      metadata: {
        originalSize: inputSize,
        outputSize: outputStat.size,
        mode: 'transcode',
        output_format,
        video_codec,
        audio_codec,
        dimensions: targetWidth && targetHeight ? `${targetWidth}x${targetHeight}` : `${sourceWidth}x${sourceHeight}`,
        duration: sourceDuration,
        mimeType: MIME_TYPES[output_format] || 'video/mp4',
      },
    };
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
            const mappedPercent = Math.min(95, 15 + Math.round(Math.min(100, p.percent) * 0.75));
            onProgress?.(mappedPercent, `Extracting: ${Math.round(Math.min(100, p.percent))}%`);
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

      // Apply max_dimension if no explicit width/height set
      const maxDim = options.max_dimension;
      if (!targetWidth && !targetHeight && maxDim && maxDim > 0) {
        const sourceLongEdge = Math.max(sourceWidth, sourceHeight);
        if (sourceLongEdge > maxDim) {
          const scale = maxDim / sourceLongEdge;
          targetWidth = Math.round(sourceWidth * scale);
          targetHeight = Math.round(sourceHeight * scale);
        }
      }

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
          const mappedPercent = Math.min(95, 20 + Math.round(Math.min(100, p.percent) * 0.7));
          onProgress?.(mappedPercent, `Transcoding: ${Math.round(Math.min(100, p.percent))}% (${p.speed?.toFixed(1) || '?'}x)`);
        },
        onComplete: (result) => {
          onProgress?.(95, 'Finalizing');
        },
        onError: (error) => {
          reject?.(new Error(error.message || 'nVideo transcode failed'));
        },
      };

      // Build video options
      const isNvenc = video_codec && video_codec.includes('nvenc');
      const videoOpts = {
        codec: video_codec,
      };
      if (isNvenc) {
        const presetMap = { ultrafast: 'p1', superfast: 'p2', veryfast: 'p3', faster: 'p4', fast: 'p5', medium: 'p4', slow: 'p6', slower: 'p7', veryslow: 'p7' };
        videoOpts.preset = presetMap[preset] || preset;
        videoOpts.cq = crf;
      } else {
        videoOpts.preset = preset;
        videoOpts.crf = crf;
      }
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
        video_codec,
        audio_codec,
        output_format,
        dimensions: targetWidth && targetHeight ? `${targetWidth}x${targetHeight}` : 'source',
      });

      return {
        buffer: outputBuffer,
        metadata: {
          originalSize: input.length,
          outputSize: outputBuffer.length,
          mode: 'transcode',
          output_format,
          video_codec,
          audio_codec,
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
