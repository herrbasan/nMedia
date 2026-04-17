import { parentPort, workerData } from 'worker_threads';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import fs from 'fs';
import crypto from 'crypto';
import { createRequire } from 'module';

// Guard: only run when executed as a worker_thread
if (!parentPort) {
  throw new Error('TaskWorker.js must be run as a worker_thread');
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

// Load nVideo for audio/video processing
const nVideoPath = path.join(__dirname, '../../modules/nVideo/lib/index.js');
const nVideo = require(nVideoPath);

// Load nImage for image processing
const nImagePath = path.join(__dirname, '../../modules/nImage/lib/index.js');
const nImageUrl = pathToFileURL(nImagePath).href;
let nImage;

// Audio codec mapping
const AUDIO_CODECS = { mp3: 'libmp3lame', wav: 'pcm_s16le', ogg: 'libvorbis', m4a: 'aac' };
const FORMAT_EXTENSIONS = { mp3: 'mp3', wav: 'wav', ogg: 'ogg', m4a: 'm4a' };
const MIME_TYPES = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4' };

async function initNImage() {
  if (!nImage) {
    nImage = (await import(nImageUrl)).default;
  }
  return nImage;
}

function detectInputExtension(buffer) {
  if (buffer.length < 12) return 'bin';
  const magic = buffer.slice(0, 12).toString('hex').toUpperCase();
  if (magic.startsWith('494433') || magic.startsWith('FFE')) return 'mp3';
  if (magic.startsWith('52494646')) return 'wav';
  if (magic.startsWith('4F676753')) return 'ogg';
  if (buffer.slice(4, 8).toString('hex').toUpperCase() === '66747970') {
    const brand = buffer.slice(8, 12).toString('ascii');
    if (brand.startsWith('qt')) return 'mov';
    return 'mp4';
  }
  if (magic.startsWith('1A45DFA3')) return 'webm';
  if (magic.startsWith('664C6143')) return 'flac';
  if (buffer.slice(4, 10).toString('ascii') === 'ftypqt') return 'mov';
  return 'bin';
}

function resolveInputPath(inputSource, cacheDir) {
  if (inputSource.type === 'path') {
    return inputSource.value;
  }
  // Buffer input: write to temp file
  const inputId = crypto.randomUUID();
  const inputExt = detectInputExtension(inputSource.value);
  const inputPath = path.join(cacheDir, `input-${inputId}.${inputExt}`);
  fs.writeFileSync(inputPath, inputSource.value);
  return inputPath;
}

async function processAudio(inputSource, options, cacheDir) {
  const { sample_rate = 16000, channels = 1, format = 'mp3' } = options;

  const inputPath = resolveInputPath(inputSource, cacheDir);
  const shouldCleanupInput = inputSource.type === 'buffer';
  const outputId = crypto.randomUUID();
  const outputPath = path.join(cacheDir, `output-${outputId}.${FORMAT_EXTENSIONS[format] || format}`);

  try {
    await new Promise((resolve, reject) => {
      nVideo.transcode(inputPath, outputPath, {
        audio: {
          codec: AUDIO_CODECS[format],
          sampleRate: sample_rate,
          channels: channels,
          bitrate: format === 'mp3' || format === 'm4a' ? 128000 : 0,
        },
        cache: false,
        onProgress: (p) => {
          parentPort.postMessage({ type: 'progress', percent: p.percent, message: `Processing: ${Math.round(p.percent)}%` });
        },
        onComplete: (result) => resolve(result),
        onError: (error) => reject(new Error(error.message || 'nVideo transcode failed')),
      });
    });

    const outputBuffer = fs.readFileSync(outputPath);
    return { buffer: outputBuffer, metadata: { outputSize: outputBuffer.length, sampleRate: sample_rate, channels, format, mimeType: MIME_TYPES[format] } };
  } finally {
    if (shouldCleanupInput) { try { fs.unlinkSync(inputPath); } catch {} }
    try { fs.unlinkSync(outputPath); } catch {}
  }
}

async function processVideo(inputSource, options, cacheDir) {
  const { mode = 'extract_audio', fps = 1, max_dimension = 1024, format = 'mp3' } = options;
  const inputPath = resolveInputPath(inputSource, cacheDir);
  const shouldCleanupInput = inputSource.type === 'buffer';

  if (mode === 'extract_audio') {
    parentPort.postMessage({ type: 'progress', percent: 5, message: 'Mode: extract_audio' });
    const outputId = crypto.randomUUID();
    const outputPath = path.join(cacheDir, `output-${outputId}.${format}`);

    try {
      await new Promise((resolve, reject) => {
        nVideo.extractAudio(inputPath, outputPath, {
          codec: AUDIO_CODECS[format],
          bitrate: 128000,
          cache: false,
          onProgress: (p) => {
            parentPort.postMessage({ type: 'progress', percent: p.percent, message: `Extracting audio: ${Math.round(p.percent)}%` });
          },
          onComplete: (result) => resolve(result),
          onError: (error) => reject(new Error(error.message || 'nVideo extractAudio failed')),
        });
      });

      const outputBuffer = fs.readFileSync(outputPath);
      return { buffer: outputBuffer, metadata: { outputSize: outputBuffer.length, mode, format, mimeType: MIME_TYPES[format] } };
    } finally {
      if (shouldCleanupInput) { try { fs.unlinkSync(inputPath); } catch {} }
      try { fs.unlinkSync(outputPath); } catch {}
    }
  }

  if (mode === 'transcode') {
    parentPort.postMessage({ type: 'progress', percent: 5, message: 'Mode: transcode' });
    const output_format = options.output_format || 'mp4';
    const video_codec = options.video_codec || 'libx264';
    const audio_codec = options.audio_codec || 'aac';
    const width = options.width ? parseInt(options.width) : undefined;
    const height = options.height ? parseInt(options.height) : undefined;
    const crf = options.crf !== undefined ? parseInt(options.crf) : 23;
    const preset = options.preset || 'medium';
    const audio_bitrate = options.audio_bitrate !== undefined ? parseInt(options.audio_bitrate) : 128000;
    const output_fps = options.fps ? parseInt(options.fps) : undefined;
    const isNvenc = video_codec === 'h264_nvenc' || video_codec === 'hevc_nvenc';

    parentPort.postMessage({ type: 'progress', percent: 10, message: 'Probing source video' });
    const probeResult = nVideo.probe(inputPath);
    const videoStream = probeResult.streams.find(s => s.type === 'video');
    parentPort.postMessage({ type: 'progress', percent: 15, message: `Source: ${videoStream?.width}x${videoStream?.height}, ${probeResult.format.duration?.toFixed(1) || '?'}s` });
    const audioStream = probeResult.streams.find(s => s.type === 'audio');
    const sourceWidth = videoStream?.width;
    const sourceHeight = videoStream?.height;
    const sourceDuration = probeResult.format.duration;

    let targetWidth = width;
    let targetHeight = height;
    if (targetWidth && !targetHeight) {
      targetHeight = Math.round(sourceHeight * (targetWidth / sourceWidth));
    } else if (targetHeight && !targetWidth) {
      targetWidth = Math.round(sourceWidth * (targetHeight / sourceHeight));
    }
    if (targetWidth) targetWidth = targetWidth % 2 === 0 ? targetWidth : targetWidth + 1;
    if (targetHeight) targetHeight = targetHeight % 2 === 0 ? targetHeight : targetHeight + 1;

    const outputId = crypto.randomUUID();
    const outputExt = { mp4: 'mp4', webm: 'webm', mkv: 'mkv', mov: 'mov' }[output_format] || output_format;
    const outputPath = path.join(cacheDir, `output-${outputId}.${outputExt}`);

    try {
      const transcodeOpts = {
        cache: false,
        video: { codec: video_codec, preset },
      };
      // NVENC codecs do not support CRF; omitting prevents native crash
      if (!isNvenc) transcodeOpts.video.crf = crf;
      if (targetWidth) transcodeOpts.video.width = targetWidth;
      if (targetHeight) transcodeOpts.video.height = targetHeight;
      if (output_fps) transcodeOpts.video.fps = output_fps;
      if (audioStream) {
        transcodeOpts.audio = { codec: audio_codec, bitrate: audio_bitrate };
      }

      await new Promise((resolve, reject) => {
        transcodeOpts.onProgress = (p) => {
          const msg = p.speed ? `Transcoding: ${Math.round(p.percent)}% (${p.speed.toFixed(1)}x)` : `Transcoding: ${Math.round(p.percent)}%`;
          parentPort.postMessage({ type: 'progress', percent: p.percent, message: msg });
        };
        transcodeOpts.onComplete = (result) => resolve(result);
        transcodeOpts.onError = (error) => reject(new Error(error.message || 'nVideo transcode failed'));
        nVideo.transcode(inputPath, outputPath, transcodeOpts);
      });

      const outputBuffer = fs.readFileSync(outputPath);
      return {
        buffer: outputBuffer,
        metadata: {
          outputSize: outputBuffer.length,
          mode: 'transcode',
          output_format,
          video_codec,
          audio_codec,
          dimensions: targetWidth && targetHeight ? `${targetWidth}x${targetHeight}` : `${sourceWidth}x${sourceHeight}`,
          duration: sourceDuration,
          mimeType: { mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', mov: 'video/quicktime' }[output_format] || 'video/mp4',
        },
      };
    } finally {
      if (shouldCleanupInput) { try { fs.unlinkSync(inputPath); } catch {} }
      try { fs.unlinkSync(outputPath); } catch {}
    }
  }

  // extract_keyframes
  parentPort.postMessage({ type: 'progress', percent: 5, message: 'Mode: extract_keyframes' });
  try {
    const probeResult = nVideo.probe(inputPath);
    const videoStream = probeResult.streams.find(s => s.type === 'video');
    if (!videoStream) throw new Error('No video stream found');

    const duration = probeResult.format.duration;
    const frameWidth = Math.min(max_dimension, videoStream.width);
    const frameInterval = 1 / fps;
    const frameCount = Math.floor(duration * fps);
    const frames = [];

    const img = await initNImage();

    for (let i = 0; i < frameCount; i++) {
      const timestamp = i * frameInterval;
      parentPort.postMessage({ type: 'progress', percent: (i / frameCount) * 100, message: `Extracted ${i + 1}/${frameCount} frames` });

      const thumb = nVideo.thumbnail(inputPath, { timestamp, width: frameWidth });
      const jpegBuffer = await img({ data: thumb.data, width: thumb.width, height: thumb.height, channels: 3 }).jpeg({ quality: 85 }).toBuffer();
      frames.push(jpegBuffer);
    }

    return {
      buffer: frames[0] || Buffer.alloc(0),
      metadata: { frameCount: frames.length, mode, format: 'jpeg', fps, maxDimension: max_dimension, mimeType: 'image/jpeg' },
      frames,
    };
  } finally {
    if (shouldCleanupInput) { try { fs.unlinkSync(inputPath); } catch {} }
  }
}

async function processImage(inputSource, options) {
  let inputBuffer;
  if (inputSource.type === 'path') {
    inputBuffer = fs.readFileSync(inputSource.value);
  } else {
    inputBuffer = inputSource.value;
  }

  const { max_dimension = 1024, quality = 85, format = 'jpeg' } = options;
  const img = await initNImage();

  let pipeline = img(inputBuffer);
  const meta = await img(inputBuffer).metadata();
  let width = meta.width;
  let height = meta.height;

  if (max_dimension && (width > max_dimension || height > max_dimension)) {
    if (width > height) {
      height = Math.round((height / width) * max_dimension);
      width = max_dimension;
    } else {
      width = Math.round((width / height) * max_dimension);
      height = max_dimension;
    }
    pipeline = pipeline.resize(width, height, { fit: 'inside' });
  }

  if (format === 'jpeg') pipeline = pipeline.jpeg({ quality });
  else if (format === 'png') pipeline = pipeline.png();
  else if (format === 'webp') pipeline = pipeline.webp({ quality });
  else if (format === 'avif') pipeline = pipeline.avif({ quality });

  const outputBuffer = await pipeline.toBuffer();
  const outputMeta = await img(outputBuffer).metadata();

  return {
    buffer: outputBuffer,
    metadata: { outputSize: outputBuffer.length, width: outputMeta.width, height: outputMeta.height, format, mimeType: `image/${format === 'jpeg' ? 'jpeg' : format}` },
  };
}

// Message handler
parentPort.on('message', async (message) => {
  const { type, mediaType, inputSource, options, cacheDir } = message;

  if (type !== 'process') {
    parentPort.postMessage({ type: 'error', message: `Unknown message type: ${type}` });
    return;
  }

  const mode = options?.mode || 'extract_audio';
  const inputDesc = inputSource?.type === 'path' ? inputSource.value : '<buffer>';
  parentPort.postMessage({ type: 'progress', percent: 0, message: `TaskWorker started: ${mediaType} / ${mode}` });

  try {
    let result;
    if (mediaType === 'audio') {
      result = await processAudio(inputSource, options, cacheDir);
    } else if (mediaType === 'video') {
      result = await processVideo(inputSource, options, cacheDir);
    } else if (mediaType === 'image') {
      result = await processImage(inputSource, options);
    } else {
      throw new Error(`Unknown media type: ${mediaType}`);
    }

    parentPort.postMessage({ type: 'progress', percent: 99, message: 'Finalizing result' });
    parentPort.postMessage({ type: 'complete', result });
  } catch (error) {
    parentPort.postMessage({ type: 'error', message: error.message });
  }
});
