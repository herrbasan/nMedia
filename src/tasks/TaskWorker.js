import { parentPort, workerData } from 'worker_threads';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import fs from 'fs';
import crypto from 'crypto';
import { createRequire } from 'module';

const isThreadWorker = !!parentPort;
const isProcessWorker = !!process.send;

// Guard: only run when executed as a worker
if (!isThreadWorker && !isProcessWorker) {
  throw new Error('TaskWorker.js must be run as a worker_thread or child_process');
}

const sendMessage = (msg) => {
  if (isThreadWorker) parentPort.postMessage(msg);
  else if (isProcessWorker) process.send(msg);
};

const messageEmitter = isThreadWorker ? parentPort : process;

const taskId = isThreadWorker ? workerData?.taskId : process.env.TASK_ID;

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
const AUDIO_CODECS = { mp3: 'libmp3lame', wav: 'pcm_s16le', ogg: 'libvorbis', m4a: 'aac', flac: 'flac', aac: 'aac', opus: 'libopus' };
const FORMAT_EXTENSIONS = { mp3: 'mp3', wav: 'wav', ogg: 'ogg', m4a: 'm4a', flac: 'flac', aac: 'aac', opus: 'opus' };
const MIME_TYPES = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac', aac: 'audio/aac', opus: 'audio/opus' };

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
  const rawSampleRate = options.sample_rate ?? 'source';
  const rawChannels = options.channels ?? 'source';
  const format = options.format || 'mp3';
  const sampleRate = rawSampleRate === 'source' ? 0 : parseInt(rawSampleRate, 10);
  const channelCount = rawChannels === 'source' ? 0 : parseInt(rawChannels, 10);
  const bitrate = options.audio_bitrate || (format === 'mp3' || format === 'm4a' ? 128000 : 0);

  const inputPath = resolveInputPath(inputSource, cacheDir);
  const shouldCleanupInput = inputSource.type === 'buffer';
  const outputId = crypto.randomUUID();
  const outputPath = path.join(cacheDir, `output-${outputId}.${FORMAT_EXTENSIONS[format] || format}`);

  try {
    await new Promise((resolve, reject) => {
      nVideo.transcode(inputPath, outputPath, {
        audio: {
          codec: AUDIO_CODECS[format],
          sampleRate,
          channels: channelCount,
          bitrate,
        },
        cache: false,
        onProgress: (p) => {
          sendMessage({ type: 'progress', percent: p.percent, message: `Processing: ${Math.round(p.percent)}%` });
        },
        onComplete: (result) => resolve(result),
        onError: (error) => reject(new Error(error.message || 'nVideo transcode failed')),
      });
    });

      const stat = fs.statSync(outputPath);
      return { 
        filePath: outputPath,
        metadata: { outputSize: stat.size, sampleRate, channels: channelCount, format, mimeType: MIME_TYPES[format] } 
      };
    } finally {
      if (shouldCleanupInput) { try { fs.unlinkSync(inputPath); } catch {} }    }
  }
async function processVideo(inputSource, options, cacheDir) {
  const { mode = 'extract_audio', fps = 1, max_dimension = 1024, format = 'mp3' } = options;
  const inputPath = resolveInputPath(inputSource, cacheDir);
  const shouldCleanupInput = inputSource.type === 'buffer';

  if (mode === 'extract_audio') {
    sendMessage({ type: 'progress', percent: 5, message: 'Mode: extract_audio' });
    const outputId = crypto.randomUUID();
    const outputPath = path.join(cacheDir, `output-${outputId}.${format}`);

    try {
      await new Promise((resolve, reject) => {
        nVideo.extractAudio(inputPath, outputPath, {
          codec: AUDIO_CODECS[format],
          bitrate: options.audio_bitrate || 128000,
          cache: false,
          onProgress: (p) => {
            sendMessage({ type: 'progress', percent: p.percent, message: `Extracting audio: ${Math.round(p.percent)}%` });
          },
          onComplete: (result) => resolve(result),
          onError: (error) => reject(new Error(error.message || 'nVideo extractAudio failed')),
        });
      });

        const stat = fs.statSync(outputPath);
        return { filePath: outputPath, metadata: { outputSize: stat.size, mode, format, mimeType: MIME_TYPES[format] } };
      } finally {
        if (shouldCleanupInput) { try { fs.unlinkSync(inputPath); } catch {} }
      }
    }

    if (mode === 'transcode' || mode === 'cli') {
    sendMessage({ type: 'progress', percent: 5, message: 'Mode: transcode' });
    const output_format = options.output_format || 'mp4';
    const video_codec = options.video_codec || 'libx264';
    const audio_codec = options.audio_codec || 'aac';
    const width = options.width ? parseInt(options.width) : undefined;
    const height = options.height ? parseInt(options.height) : undefined;
    const crf = options.crf !== undefined ? parseInt(options.crf) : 23;
    const preset = options.preset || 'medium';
    const audio_bitrate = options.audio_bitrate !== undefined ? parseInt(options.audio_bitrate) : 128000;
    const output_fps = options.fps ? parseInt(options.fps) : undefined;
    const isNvenc = video_codec && video_codec.includes('nvenc');

    sendMessage({ type: 'progress', percent: 10, message: 'Probing source video' });
    const probeResult = nVideo.probe(inputPath);
    const videoStream = probeResult.streams.find(s => s.type === 'video');
    sendMessage({ type: 'progress', percent: 15, message: `Source: ${videoStream?.width}x${videoStream?.height}, ${probeResult.format.duration?.toFixed(1) || '?'}s` });
    const audioStream = probeResult.streams.find(s => s.type === 'audio');
    const sourceWidth = videoStream?.width;
    const sourceHeight = videoStream?.height;
    const sourceDuration = probeResult.format.duration;

    let targetWidth = width;
    let targetHeight = height;

    // Apply max_dimension if no explicit width/height set
    const maxDim = options.max_dimension ? parseInt(options.max_dimension) : undefined;
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

    const outputId = crypto.randomUUID();
    const outputExt = { mp4: 'mp4', webm: 'webm', mkv: 'mkv', mov: 'mov', avi: 'avi', ts: 'ts', flv: 'flv', '3gp': '3gp', ogv: 'ogv', wmv: 'wmv' }[output_format] || output_format;
    const outputPath = path.join(cacheDir, `output-${outputId}.${outputExt}`);

    try {
      const transcodeOpts = {
        cache: false,
      };
      if (options.hwaccel) {
        transcodeOpts.hwaccel = options.hwaccel;
      }
      if (options.useNative !== undefined) {
        transcodeOpts.useNative = options.useNative;
      }
      if (options.cli_command) {
        transcodeOpts.cli_command = options.cli_command;
      }

      if (!options.no_video) {
        transcodeOpts.video = { codec: video_codec };
        if (isNvenc) {
          // NVENC uses p1-p7 presets and cq (not crf)
          const presetMap = { ultrafast: 'p1', superfast: 'p2', veryfast: 'p3', faster: 'p4', fast: 'p5', medium: 'p4', slow: 'p6', slower: 'p7', veryslow: 'p7' };
          transcodeOpts.video.preset = presetMap[preset] || preset;
          transcodeOpts.video.cq = crf;
        } else {
          transcodeOpts.video.preset = preset;
          transcodeOpts.video.crf = crf;
        }
        if (options.videoOptions) {
          transcodeOpts.video.options = options.videoOptions;
        }
        if (targetWidth) transcodeOpts.video.width = targetWidth;
        if (targetHeight) transcodeOpts.video.height = targetHeight;
        if (output_fps) transcodeOpts.video.fps = output_fps;
      } else {
        transcodeOpts.video = null;
      }
      if (audioStream && !options.no_audio) {
        transcodeOpts.audio = { codec: audio_codec, bitrate: audio_bitrate };
        if (options.audioOptions) {
          transcodeOpts.audio.options = options.audioOptions;
        }
      } else if (options.no_audio) {
        transcodeOpts.audio = null;
      }

      await new Promise((resolve, reject) => {
        transcodeOpts.onProgress = (p) => {
          const msg = p.speed ? `Transcoding: ${Math.round(p.percent)}% (${p.speed.toFixed(1)}x)` : `Transcoding: ${Math.round(p.percent)}%`;
          sendMessage({ type: 'progress', percent: p.percent, message: msg });
        };
        transcodeOpts.onComplete = (result) => resolve(result);
        transcodeOpts.onError = (error) => reject(new Error(error.message || 'nVideo transcode failed'));
        nVideo.transcode(inputPath, outputPath, transcodeOpts);
      });

        const stat = fs.statSync(outputPath);
        return {
          filePath: outputPath,
          metadata: {
            outputSize: stat.size,
            mode: 'transcode',
            output_format,
            video_codec,
            audio_codec,
            dimensions: targetWidth && targetHeight ? `${targetWidth}x${targetHeight}` : `${sourceWidth}x${sourceHeight}`,
            duration: sourceDuration,
            mimeType: { mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', mov: 'video/quicktime', avi: 'video/x-msvideo', ts: 'video/mp2t', flv: 'video/x-flv', '3gp': 'video/3gpp', ogv: 'video/ogg', wmv: 'video/x-ms-wmv' }[output_format] || 'video/mp4',
          },
        };
      } finally {
        if (shouldCleanupInput) { try { fs.unlinkSync(inputPath); } catch {} }
      }
    }

  // extract_keyframes
  sendMessage({ type: 'progress', percent: 5, message: 'Mode: extract_keyframes' });
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
      sendMessage({ type: 'progress', percent: (i / frameCount) * 100, message: `Extracted ${i + 1}/${frameCount} frames` });

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

  const {
    max_dimension = 1024,
    quality = 85,
    format = 'jpeg',
    strip_exif = true,
    crop = null,
    rotate = null,
    flip = false,
    flop = false,
    grayscale = false,
    normalize = false,
    blur = 0,
  } = options;

  const parsedRotate = rotate ? parseInt(rotate) : null;
  } = options;

  const img = await initNImage();

  const meta = await img(inputBuffer).metadata();
  sendMessage({ type: 'progress', percent: 15, message: `Detected: ${meta.format || 'unknown'}, ${meta.width}x${meta.height}` });

  if (crop) {
    return processImageCrop(img, inputBuffer, meta, crop, format, quality);
  }

  let pipeline = img(inputBuffer);

  if (parsedRotate) {
    sendMessage({ type: 'progress', percent: 20, message: `Rotating ${parsedRotate}°` });
    pipeline = pipeline.rotate(parsedRotate);
  }

  if (flip) {
    sendMessage({ type: 'progress', percent: 22, message: 'Flipping vertically' });
    pipeline = pipeline.flip();
  }

  if (flop) {
    sendMessage({ type: 'progress', percent: 24, message: 'Flopping horizontally' });
    pipeline = pipeline.flop();
  }

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
    sendMessage({ type: 'progress', percent: 30, message: `Resizing to ${width}x${height}` });
    pipeline = pipeline.resize(width, height, { fit: 'inside' });
  }

  if (grayscale) {
    sendMessage({ type: 'progress', percent: 40, message: 'Converting to grayscale' });
    pipeline = pipeline.grayscale();
  }

  if (normalize) {
    sendMessage({ type: 'progress', percent: 45, message: 'Normalizing contrast' });
    pipeline = pipeline.normalize();
  }

  if (blur > 0) {
    sendMessage({ type: 'progress', percent: 48, message: `Applying blur (sigma: ${blur})` });
    pipeline = pipeline.blur(blur);
  }

  sendMessage({ type: 'progress', percent: 70, message: `Converting to ${format}` });

  if (format === 'jpeg') pipeline = pipeline.jpeg({ quality });
  else if (format === 'png') pipeline = pipeline.png({ quality });
  else if (format === 'webp') pipeline = pipeline.webp({ quality });
  else if (format === 'avif') pipeline = pipeline.avif({ quality });
  else if (format === 'gif') pipeline = pipeline.png({ quality });

  sendMessage({ type: 'progress', percent: 85, message: 'Encoding output' });
  const outputBuffer = await pipeline.toBuffer();
  const outputMeta = await img(outputBuffer).metadata();

  return {
    buffer: outputBuffer,
    metadata: { outputSize: outputBuffer.length, width: outputMeta.width, height: outputMeta.height, format, mimeType: `image/${format === 'jpeg' ? 'jpeg' : format}` },
  };
}

async function processImageCrop(img, inputBuffer, meta, cropOptions, format, quality) {
  const { type, left, top, right, bottom, width: widthPercent, height: heightPercent, cols: gridCols, rows: gridRows, cells = [] } = cropOptions;
  const results = [];

  if (type === 'region') {
    const leftPx = Math.round(left * meta.width);
    const topPx = Math.round(top * meta.height);
    const rightPx = Math.round(right * meta.width);
    const bottomPx = Math.round(bottom * meta.height);
    const cropWidth = rightPx - leftPx;
    const cropHeight = bottomPx - topPx;

    sendMessage({ type: 'progress', percent: 30, message: `Cropping region ${leftPx}x${topPx} to ${cropWidth}x${cropHeight}` });
    const cropped = await img(inputBuffer).extract({ left: leftPx, top: topPx, width: cropWidth, height: cropHeight }).toBuffer();
    results.push({ buffer: cropped, width: cropWidth, height: cropHeight });
  } else if (type === 'center') {
    const pct = widthPercent || 50;
    const heightPct = heightPercent || pct;
    const cropWidth = Math.round(meta.width * (pct / 100));
    const cropHeight = Math.round(meta.height * (heightPct / 100));
    const leftPx = Math.round((meta.width - cropWidth) / 2);
    const topPx = Math.round((meta.height - cropHeight) / 2);

    sendMessage({ type: 'progress', percent: 30, message: `Center cropping to ${cropWidth}x${cropHeight}` });
    const cropped = await img(inputBuffer).extract({ left: leftPx, top: topPx, width: cropWidth, height: cropHeight }).toBuffer();
    results.push({ buffer: cropped, width: cropWidth, height: cropHeight });
  } else if (type === 'grid') {
    const cols = gridCols || 3;
    const rows = gridRows || 3;
    const cellWidth = Math.floor(meta.width / cols);
    const cellHeight = Math.floor(meta.height / rows);
    const allCells = cells.length > 0 ? cells : Array.from({ length: cols * rows }, (_, i) => i);

    sendMessage({ type: 'progress', percent: 20, message: `Grid ${cols}x${rows}, extracting ${allCells.length} cells` });

    for (let i = 0; i < allCells.length; i++) {
      const cellIndex = allCells[i];
      const col = cellIndex % cols;
      const row = Math.floor(cellIndex / cols);
      const leftPx = col * cellWidth;
      const topPx = row * cellHeight;

      sendMessage({ type: 'progress', percent: 20 + Math.round((i / allCells.length) * 60), message: `Extracting cell ${cellIndex}` });

      const cropped = await img(inputBuffer).extract({ left: leftPx, top: topPx, width: cellWidth, height: cellHeight }).toBuffer();
      results.push({ buffer: cropped, width: cellWidth, height: cellHeight, cellIndex });
    }
  }

  sendMessage({ type: 'progress', percent: 85, message: 'Encoding output' });

  const encoded = await Promise.all(results.map(async (r) => {
    let pipeline = img(r.buffer);
    if (format === 'jpeg') pipeline = pipeline.jpeg({ quality });
    else if (format === 'png') pipeline = pipeline.png({ quality });
    else if (format === 'webp') pipeline = pipeline.webp({ quality });
    else if (format === 'avif') pipeline = pipeline.avif({ quality });
    else if (format === 'gif') pipeline = pipeline.png({ quality });
    const encodedBuffer = await pipeline.toBuffer();
    return { buffer: encodedBuffer, width: r.width, height: r.height, cellIndex: r.cellIndex };
  }));

  sendMessage({ type: 'progress', percent: 100, message: 'Complete' });

  const allBuffers = encoded.map(e => e.buffer);
  const firstBuffer = allBuffers[0] || Buffer.alloc(0);

  return {
    buffer: firstBuffer,
    metadata: {
      outputSize: firstBuffer.length,
      width: encoded[0]?.width,
      height: encoded[0]?.height,
      format,
      mimeType: `image/${format === 'jpeg' ? 'jpeg' : format}`,
      cropType: type,
      cropCount: encoded.length,
      crops: encoded.map((e, i) => ({
        index: e.cellIndex ?? i,
        width: e.width,
        height: e.height,
        size: e.buffer.length,
      })),
    },
    extraBuffers: allBuffers.slice(1),
  };
}

// Message handler
messageEmitter.on('message', async (message) => {
  const { type, mediaType, inputSource, options, cacheDir } = message;

  if (type !== 'process') {
    sendMessage({ type: 'error', message: `Unknown message type: ${type}` });
    return;
  }

  const mode = options?.mode || 'extract_audio';
  const inputDesc = inputSource?.type === 'path' ? inputSource.value : '<buffer>';
  sendMessage({ type: 'progress', percent: 0, message: `TaskWorker started: ${mediaType} / ${mode}` });

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

    sendMessage({ type: 'progress', percent: 99, message: 'Finalizing result' });
    sendMessage({ type: 'complete', result });
  } catch (error) {
    sendMessage({ type: 'error', message: error.message });
  }
});
