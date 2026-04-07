import config from '../../config/config.js';

/**
 * GPU codec configurations for FFmpeg
 * Maps GPU platforms to appropriate decode/encode codecs
 */

export const GPU_PLATFORMS = {
  NVENC: 'nvenc',
  VAAPI: 'vaapi',
  QSV: 'qsv',
  CPU: 'cpu',
};

/**
 * Video codec mappings per GPU platform
 */
const VIDEO_CODECS = {
  [GPU_PLATFORMS.NVENC]: {
    decode: {
      h264: 'h264_cuvid',
      hevc: 'hevc_cuvid',
      mpeg2: 'mpeg2_cuvid',
      mpeg4: 'mpeg4_cuvid',
      vp8: 'vp8_cuvid',
      vp9: 'vp9_cuvid',
    },
    encode: {
      h264: 'h264_nvenc',
      hevc: 'hevc_nvenc',
    },
  },
  [GPU_PLATFORMS.VAAPI]: {
    decode: {
      h264: 'h264',
      hevc: 'hevc',
    },
    encode: {
      h264: 'h264_vaapi',
      hevc: 'hevc_vaapi',
    },
  },
  [GPU_PLATFORMS.QSV]: {
    decode: {
      h264: 'h264_qsv',
      hevc: 'hevc_qsv',
    },
    encode: {
      h264: 'h264_qsv',
      hevc: 'hevc_qsv',
    },
  },
  [GPU_PLATFORMS.CPU]: {
    decode: {},
    encode: {
      h264: 'libx264',
      hevc: 'libx265',
    },
  },
};

/**
 * Audio codec mappings (CPU only - no GPU acceleration for audio)
 */
const AUDIO_CODECS = {
  mp3: 'libmp3lame',
  aac: 'aac',
  m4a: 'aac',
  wav: 'pcm_s16le',
  flac: 'flac',
  ogg: 'libvorbis',
  opus: 'libopus',
};

/**
 * Container format to extension mapping
 */
export const FORMAT_EXTENSIONS = {
  mp3: 'mp3',
  wav: 'wav',
  ogg: 'ogg',
  m4a: 'm4a',
  mp4: 'mp4',
  webm: 'webm',
  mov: 'mov',
  mkv: 'mkv',
  avi: 'avi',
  jpeg: 'jpg',
  png: 'png',
  gif: 'gif',
  webp: 'webp',
  avif: 'avif',
};

/**
 * MIME type mapping
 */
export const MIME_TYPES = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  opus: 'audio/opus',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
};

/**
 * Get the current GPU platform from config
 * @returns {string}
 */
export function getGpuPlatform() {
  return config.gpuPlatform || GPU_PLATFORMS.CPU;
}

/**
 * Get the GPU device index from config
 * @returns {number}
 */
export function getGpuDevice() {
  return config.gpuDevice || 0;
}

/**
 * Get video decode codec for input format
 * @param {string} format - Input format (h264, hevc, etc.)
 * @returns {string|null}
 */
export function getVideoDecodeCodec(format) {
  const platform = getGpuPlatform();
  const codecs = VIDEO_CODECS[platform]?.decode;
  return codecs?.[format] || null;
}

/**
 * Get video encode codec for output format
 * @param {string} format - Output format (h264, hevc)
 * @returns {string}
 */
export function getVideoEncodeCodec(format) {
  const platform = getGpuPlatform();
  const codec = VIDEO_CODECS[platform]?.encode?.[format];
  if (codec) return codec;
  
  // Fallback to CPU
  return VIDEO_CODECS[GPU_PLATFORMS.CPU].encode[format] || 'libx264';
}

/**
 * Get audio codec for output format
 * @param {string} format - Output format (mp3, aac, wav, etc.)
 * @returns {string|null}
 */
export function getAudioCodec(format) {
  return AUDIO_CODECS[format] || null;
}

/**
 * Build hardware acceleration initialization arguments
 * @returns {string[]}
 */
export function getHwAccelArgs() {
  const platform = getGpuPlatform();
  const device = getGpuDevice();

  switch (platform) {
    case GPU_PLATFORMS.NVENC:
      return ['-hwaccel', 'cuda', '-hwaccel_device', String(device)];
    
    case GPU_PLATFORMS.VAAPI:
      return ['-hwaccel', 'vaapi', '-hwaccel_device', `/dev/dri/renderD${128 + device}`];
    
    case GPU_PLATFORMS.QSV:
      return ['-hwaccel', 'qsv'];
    
    case GPU_PLATFORMS.CPU:
    default:
      return [];
  }
}

/**
 * Check if hardware acceleration is available
 * @returns {boolean}
 */
export function hasHardwareAccel() {
  return getGpuPlatform() !== GPU_PLATFORMS.CPU;
}

/**
 * Get video filter arguments for hardware acceleration
 * @param {string[]} filters - Base filters to apply
 * @returns {string[]}
 */
export function getVideoFilterArgs(filters) {
  const platform = getGpuPlatform();
  
  if (platform === GPU_PLATFORMS.CPU || !filters.length) {
    return filters.length ? ['-vf', filters.join(',')] : [];
  }

  // For hardware accel, filters need to be wrapped
  switch (platform) {
    case GPU_PLATFORMS.NVENC:
      // NVENC can use software filters with hwupload/hwdownload
      return ['-vf', [...filters, 'hwupload_cuda'].join(',')];
    
    case GPU_PLATFORMS.VAAPI:
      return ['-vf', [...filters, 'hwupload'].join(',')];
    
    case GPU_PLATFORMS.QSV:
      return ['-vf', [...filters, 'hwupload=extra_hw_frames=64'].join(',')];
    
    default:
      return filters.length ? ['-vf', filters.join(',')] : [];
  }
}

/**
 * Build complete FFmpeg arguments for audio processing
 * @param {Object} options
 * @param {string} options.format - Output format (mp3, wav, ogg, m4a)
 * @param {number} options.sampleRate - Sample rate (8000, 16000, etc.)
 * @param {number} options.channels - Channel count (1 or 2)
 * @returns {string[]}
 */
export function buildAudioArgs({ format, sampleRate, channels }) {
  const args = [];
  
  // Audio codec
  const codec = getAudioCodec(format);
  if (codec) {
    args.push('-c:a', codec);
  }
  
  // Sample rate
  if (sampleRate) {
    args.push('-ar', String(sampleRate));
  }
  
  // Channels
  if (channels) {
    args.push('-ac', String(channels));
  }
  
  // Format-specific options
  if (format === 'mp3') {
    args.push('-b:a', '128k');
  } else if (format === 'ogg') {
    args.push('-q:a', '4');
  } else if (format === 'm4a') {
    args.push('-b:a', '128k');
  }
  
  return args;
}

/**
 * Build complete FFmpeg arguments for video processing
 * @param {Object} options
 * @param {string} options.mode - Processing mode
 * @param {string} options.outputFormat - Output format
 * @param {number} options.fps - FPS for keyframe extraction
 * @param {number} options.maxDimension - Max dimension for frames
 * @returns {string[]}
 */
export function buildVideoArgs({ mode, outputFormat, fps, maxDimension }) {
  const args = [];
  
  if (mode === 'extract_audio') {
    args.push('-vn');
    args.push('-c:a', 'libmp3lame', '-b:a', '128k');
  } else if (mode === 'extract_keyframes') {
    const frameFps = fps || 1;
    const maxDim = maxDimension || 1024;
    
    // Video filter for FPS and scale
    const filters = [`fps=${frameFps}`, `scale='min(${maxDim},iw)':-1:flags=lanczos`];
    args.push(...getVideoFilterArgs(filters));
    
    // Output format for image sequence
    args.push('-q:v', '2');
  }
  
  return args;
}
