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

// Standalone option validators (mirror Processor.validateOptions)
function validateImageOptions(options) {
  const { max_dimension, quality, format, rotate, blur, crop } = options;
  if (max_dimension !== undefined && (max_dimension < 1 || max_dimension > 10000)) {
    throw new Error('max_dimension must be between 1 and 10000');
  }
  if (quality !== undefined && (quality < 1 || quality > 100)) {
    throw new Error('quality must be between 1 and 100');
  }
  if (format !== undefined && !['jpeg', 'png', 'webp', 'avif', 'gif'].includes(format)) {
    throw new Error('format must be jpeg, png, webp, avif, or gif');
  }
  const parsedRotate = rotate !== undefined && rotate !== null ? parseInt(rotate) : undefined;
  if (parsedRotate !== undefined && ![90, 180, 270].includes(parsedRotate)) {
    throw new Error('rotate must be 90, 180, or 270');
  }
  if (blur !== undefined && (blur < 0 || blur > 20)) {
    throw new Error('blur sigma must be between 0 and 20');
  }
  if (crop !== undefined) {
    if (typeof crop !== 'object') throw new Error('crop must be an object');
    if (!['region', 'center', 'grid'].includes(crop.type)) {
      throw new Error('crop.type must be "region", "center", or "grid"');
    }
  }
}

function validateAudioOptions(options) {
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

function validateVideoOptions(options) {
  const { mode, fps } = options;
  if (mode !== undefined && !['extract_audio', 'extract_keyframes', 'transcode', 'cli'].includes(mode)) {
    throw new Error('mode must be extract_audio, extract_keyframes, transcode, or cli');
  }
  if (fps !== undefined && (fps < 1 || fps > 30)) {
    throw new Error('fps must be between 1 and 30');
  }
}

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
    const codec = AUDIO_CODECS[format];
    if (!codec) throw new Error(`Unsupported audio format: ${format}`);
    const bitrate = options.audio_bitrate || 128000;
    const brK = Math.floor(bitrate / 1000);
    const cliCommand = `-vn -c:a ${codec} -b:a ${brK}k`;
    const outputId = crypto.randomUUID();
    const outputPath = path.join(cacheDir, `output-${outputId}.${format}`);

    try {
      await runFfmpeg(inputPath, outputPath, cliCommand);
      const stat = fs.statSync(outputPath);
      return { filePath: outputPath, metadata: { outputSize: stat.size, mode, format, mimeType: MIME_TYPES[format] } };
    } finally {
      if (shouldCleanupInput) { try { fs.unlinkSync(inputPath); } catch {} }
    }
  }

  if (mode === 'transcode') {
    sendMessage({ type: 'progress', percent: 5, message: 'Mode: transcode' });
    const cliCommand = options.cli_command || '-c:v libx264 -crf 23 -preset medium -c:a aac -b:a 128k';
    const outputExt = path.extname(inputPath).slice(1) || 'mp4';
    const outputId = crypto.randomUUID();
    const outputPath = path.join(cacheDir, `output-${outputId}.${outputExt}`);

    try {
      await runFfmpeg(inputPath, outputPath, cliCommand);
      const stat = fs.statSync(outputPath);
      return {
        filePath: outputPath,
        metadata: {
          outputSize: stat.size,
          mode: 'transcode',
          mimeType: MIME_TYPES[outputExt] || 'video/mp4',
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

function runFfmpeg(inputPath, outputPath, cliCommand) {
  return new Promise((resolve, reject) => {
    nVideo.transcode(inputPath, outputPath, {
      cli_command: cliCommand,
      cache: false,
      onProgress: (p) => {
        const msg = p.speed
          ? `Processing: ${Math.round(p.percent)}% (${p.speed.toFixed(1)}x)`
          : `Processing: ${Math.round(p.percent)}%`;
        sendMessage({ type: 'progress', percent: p.percent, message: msg });
      },
      onComplete: (result) => resolve(result),
      onError: (error) => reject(new Error(error.message || 'FFmpeg processing failed')),
    });
  });
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
    // Validate options before processing (mirrors PipelineExecutor behavior)
    if (mediaType === 'image') validateImageOptions(options);
    else if (mediaType === 'audio') validateAudioOptions(options);
    else if (mediaType === 'video') validateVideoOptions(options);

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
