/**
 * FFmpeg stderr progress parser
 * Parses output like: frame=  120 fps= 60 q=28.0 size=     256kB time=00:00:04.00 bitrate= 524.3kbits/s speed=  2x
 */

/**
 * Parse a single progress line from FFmpeg stderr
 * @param {string} line - Raw line from stderr
 * @returns {Object|null} - Parsed progress data or null if not a progress line
 */
export function parseProgressLine(line) {
  // Only parse lines that look like progress output
  if (!line.includes('frame=') && !line.includes('size=')) {
    return null;
  }

  const result = {
    frame: null,
    fps: null,
    q: null,
    size: null,
    time: null,
    bitrate: null,
    speed: null,
  };

  // frame=  120 or frame=120
  const frameMatch = line.match(/frame=\s*(\d+)/);
  if (frameMatch) result.frame = parseInt(frameMatch[1], 10);

  // fps= 60 or fps=60.5
  const fpsMatch = line.match(/fps=\s*([\d.]+)/);
  if (fpsMatch) result.fps = parseFloat(fpsMatch[1]);

  // q=28.0 or q=-1.0
  const qMatch = line.match(/q=\s*(-?[\d.]+)/);
  if (qMatch) result.q = parseFloat(qMatch[1]);

  // size=     256kB or size=1.5MiB or size=1024B
  const sizeMatch = line.match(/size=\s*([\d.]+)([kM]?)i?B/);
  if (sizeMatch) {
    const value = parseFloat(sizeMatch[1]);
    const unit = sizeMatch[2];
    if (unit === 'k') result.size = Math.round(value * 1024);
    else if (unit === 'M') result.size = Math.round(value * 1024 * 1024);
    else result.size = Math.round(value);
  }

  // time=00:00:04.00 or time=00:04:00.00
  const timeMatch = line.match(/time=(\d{2}):(\d{2}):(\d{2}\.\d+)/);
  if (timeMatch) {
    const hours = parseInt(timeMatch[1], 10);
    const minutes = parseInt(timeMatch[2], 10);
    const seconds = parseFloat(timeMatch[3]);
    result.time = hours * 3600 + minutes * 60 + seconds;
  }

  // bitrate= 524.3kbits/s or bitrate=N/A
  const bitrateMatch = line.match(/bitrate=\s*([\d.]+)kbits\/s/);
  if (bitrateMatch) result.bitrate = parseFloat(bitrateMatch[1]);

  // speed=  2x or speed=0.5x
  const speedMatch = line.match(/speed=\s*([\d.]+)x/);
  if (speedMatch) result.speed = parseFloat(speedMatch[1]);

  return result;
}

/**
 * Parse FFmpeg version from first line
 * @param {string} line - First line of FFmpeg output
 * @returns {string|null}
 */
export function parseVersion(line) {
  const match = line.match(/ffmpeg version (\S+)/);
  return match ? match[1] : null;
}

/**
 * Check if line indicates an error
 * @param {string} line - Line from stderr
 * @returns {boolean}
 */
export function isErrorLine(line) {
  const errorPatterns = [
    /^Error:/,
    /^Invalid/,
    /^Unknown/,
    /^Cannot/,
    /^Failed/,
    /codec not found/i,
    /does not contain any stream/i,
    /no such file/i,
  ];
  
  return errorPatterns.some(pattern => pattern.test(line));
}

/**
 * Extract error message from FFmpeg output
 * @param {string[]} lines - All stderr lines
 * @returns {string|null}
 */
export function extractError(lines) {
  for (const line of lines) {
    if (isErrorLine(line)) {
      return line.trim();
    }
  }
  return null;
}

/**
 * Calculate progress percentage from parsed data
 * @param {Object} progress - Parsed progress data
 * @param {number|null} duration - Total duration in seconds (if known)
 * @returns {number} - 0-100
 */
export function calculatePercent(progress, duration) {
  if (!progress) return 0;
  
  // If we have duration, calculate from time
  if (duration && progress.time) {
    const percent = Math.round((progress.time / duration) * 100);
    return Math.min(100, Math.max(0, percent));
  }
  
  // Otherwise estimate from frames (assuming 30fps video)
  if (progress.frame) {
    // Rough estimate: 30fps * duration, but we don't know duration
    // Just show increasing progress based on frame count
    const estimatedPercent = Math.min(95, Math.round(progress.frame / 300 * 10));
    return estimatedPercent;
  }
  
  return 0;
}

/**
 * Parse duration from FFmpeg input info
 * @param {string} line - Line containing duration info
 * @returns {number|null} - Duration in seconds
 */
export function parseDuration(line) {
  // Duration: 00:05:23.45
  const match = line.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2}\.\d+)/);
  if (match) {
    const hours = parseInt(match[1], 10);
    const minutes = parseInt(match[2], 10);
    const seconds = parseFloat(match[3]);
    return hours * 3600 + minutes * 60 + seconds;
  }
  return null;
}

/**
 * Parse input file info from FFmpeg stderr
 * @param {string} line - Line from stderr
 * @returns {Object|null}
 */
export function parseInputInfo(line) {
  // Stream #0:0: Video: h264 (Main) (avc1 / 0x31637661), yuv420p...
  const videoMatch = line.match(/Stream.*Video:\s*(\w+)/);
  if (videoMatch) {
    return { type: 'video', codec: videoMatch[1] };
  }
  
  // Stream #0:1: Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz...
  const audioMatch = line.match(/Stream.*Audio:\s*(\w+)/);
  if (audioMatch) {
    const sampleRateMatch = line.match(/(\d+)\s*Hz/);
    return { 
      type: 'audio', 
      codec: audioMatch[1],
      sampleRate: sampleRateMatch ? parseInt(sampleRateMatch[1], 10) : null,
    };
  }
  
  return null;
}
