import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import config from '../../config/config.js';
import logger from '../logger.js';
import { parseProgressLine, calculatePercent, extractError, parseDuration } from './parser.js';
import { getHwAccelArgs, buildAudioArgs, buildVideoArgs, getGpuPlatform, GPU_PLATFORMS } from './codecs.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Get FFmpeg executable path
 * @returns {string}
 */
function getFfmpegPath() {
  if (config.ffmpegPath) {
    return config.ffmpegPath;
  }
  
  // Try to find ffmpeg in PATH
  return 'ffmpeg';
}

/**
 * Ensure FFmpeg is available
 * @returns {Promise<void>}
 */
export async function verifyFfmpeg() {
  const ffmpegPath = getFfmpegPath();
  
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, ['-version'], { stdio: 'pipe' });
    let output = '';
    
    proc.stdout.on('data', (data) => {
      output += data.toString();
    });
    
    proc.on('close', (code) => {
      if (code === 0) {
        const version = output.split('\n')[0];
        logger.info('FFmpeg verified', { path: ffmpegPath, version });
        resolve();
      } else {
        reject(new Error(`FFmpeg not found or not executable: ${ffmpegPath}`));
      }
    });
    
    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn FFmpeg: ${err.message}`));
    });
  });
}

/**
 * Run FFmpeg command
 * 
 * @param {Object} options
 * @param {string} options.inputPath - Path to input file
 * @param {string} options.outputPath - Path to output file
 * @param {string[]} [options.args=[]] - Additional FFmpeg arguments
 * @param {Function} [options.onProgress] - Progress callback (percent, metadata)
 * @param {AbortSignal} [options.signal] - AbortController signal for cancellation
 * @param {number} [options.timeout=300000] - Timeout in ms (default: 5 minutes)
 * 
 * @returns {Promise<{exitCode: number, stats: Object}>}
 */
export async function run({
  inputPath,
  outputPath,
  args = [],
  onProgress,
  signal,
  timeout = 300000,
}) {
  const ffmpegPath = getFfmpegPath();
  
  // Build complete argument list
  const allArgs = [
    '-y',  // Overwrite output files without asking
    '-hide_banner',  // Hide startup banner
    '-loglevel', 'warning',  // Only show warnings and errors
    '-stats',  // Print progress stats
    '-i', inputPath,  // Input file
    ...args,  // Processing arguments
    outputPath,  // Output file
  ];
  
  logger.debug('FFmpeg starting', {
    input: inputPath,
    output: outputPath,
    args: allArgs,
  });
  
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, allArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    
    let stderr = '';
    let duration = null;
    let lastProgressPercent = 0;
    let timeoutId = null;
    let completed = false;
    
    // Handle timeout
    if (timeout > 0) {
      timeoutId = setTimeout(() => {
        if (!completed) {
          proc.kill('SIGTERM');
          reject(new Error(`FFmpeg timed out after ${timeout}ms`));
        }
      }, timeout);
    }
    
    // Handle abort signal
    if (signal) {
      const abortHandler = () => {
        if (!completed) {
          logger.debug('FFmpeg abort requested');
          proc.kill('SIGTERM');
          
          // Force kill after 5 seconds if still running
          setTimeout(() => {
            try {
              proc.kill('SIGKILL');
            } catch {
              // Process already exited
            }
          }, 5000);
        }
      };
      
      signal.addEventListener('abort', abortHandler);
      
      // Already aborted?
      if (signal.aborted) {
        abortHandler();
      }
    }
    
    // Parse stderr for progress
    proc.stderr.on('data', (data) => {
      const chunk = data.toString();
      stderr += chunk;
      
      // Parse each line
      const lines = chunk.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        
        // Try to extract duration from input info
        if (!duration && trimmed.includes('Duration:')) {
          duration = parseDuration(trimmed);
        }
        
        // Parse progress
        const progress = parseProgressLine(trimmed);
        if (progress && onProgress) {
          const percent = calculatePercent(progress, duration);
          
          // Only report if progress increased
          if (percent > lastProgressPercent) {
            lastProgressPercent = percent;
            onProgress(percent, {
              frame: progress.frame,
              fps: progress.fps,
              time: progress.time,
              bitrate: progress.bitrate,
              speed: progress.speed,
              duration,
            });
          }
        }
      }
    });
    
    // Handle process completion
    proc.on('close', (code) => {
      completed = true;
      if (timeoutId) clearTimeout(timeoutId);
      
      if (code === 0) {
        // Success - get output file stats
        let outputStats = null;
        try {
          outputStats = fs.statSync(outputPath);
        } catch {
          // File might not exist (e.g., streaming output)
        }
        
        logger.debug('FFmpeg completed', {
          input: inputPath,
          output: outputPath,
          exitCode: code,
          outputSize: outputStats?.size,
        });
        
        resolve({
          exitCode: code,
          stats: {
            outputSize: outputStats?.size || 0,
            duration,
            lastProgressPercent,
          },
        });
      } else {
        // Failure - extract error from stderr
        const errorMessage = extractError(stderr.split('\n')) || `FFmpeg exited with code ${code}`;
        logger.error('FFmpeg failed', {
          input: inputPath,
          output: outputPath,
          exitCode: code,
          error: errorMessage,
        });
        reject(new Error(errorMessage));
      }
    });
    
    proc.on('error', (err) => {
      completed = true;
      if (timeoutId) clearTimeout(timeoutId);
      
      logger.error('FFmpeg spawn error', {
        input: inputPath,
        error: err.message,
      });
      reject(new Error(`Failed to start FFmpeg: ${err.message}`));
    });
  });
}

/**
 * Run FFmpeg with hardware acceleration
 * 
 * @param {Object} options - Same as run() but with hwaccel auto-inserted
 */
export async function runWithHwAccel(options) {
  const hwaccelArgs = getHwAccelArgs();
  
  const args = [
    ...hwaccelArgs,
    ...(options.args || []),
  ];
  
  return run({
    ...options,
    args,
  });
}

/**
 * Process audio file
 * 
 * @param {Object} options
 * @param {string} options.inputPath - Input file path
 * @param {string} options.outputPath - Output file path
 * @param {string} options.format - Output format (mp3, wav, ogg, m4a)
 * @param {number} options.sampleRate - Sample rate (8000, 16000, etc.)
 * @param {number} options.channels - Channel count (1 or 2)
 * @param {Function} options.onProgress - Progress callback
 * @param {AbortSignal} options.signal - Abort signal
 * 
 * @returns {Promise<{exitCode: number, stats: Object}>}
 */
export async function processAudio({
  inputPath,
  outputPath,
  format,
  sampleRate = 16000,
  channels = 1,
  onProgress,
  signal,
}) {
  const args = buildAudioArgs({ format, sampleRate, channels });
  
  return run({
    inputPath,
    outputPath,
    args,
    onProgress,
    signal,
  });
}

/**
 * Extract audio from video
 * 
 * @param {Object} options
 * @param {string} options.inputPath - Input video path
 * @param {string} options.outputPath - Output audio path
 * @param {string} options.format - Output format (mp3)
 * @param {Function} options.onProgress - Progress callback
 * @param {AbortSignal} options.signal - Abort signal
 * 
 * @returns {Promise<{exitCode: number, stats: Object}>}
 */
export async function extractAudio({
  inputPath,
  outputPath,
  format = 'mp3',
  onProgress,
  signal,
}) {
  const args = [
    '-vn',  // No video
    '-c:a', 'libmp3lame',
    '-b:a', '128k',
  ];
  
  return runWithHwAccel({
    inputPath,
    outputPath,
    args,
    onProgress,
    signal,
  });
}

/**
 * Extract keyframes from video
 * 
 * @param {Object} options
 * @param {string} options.inputPath - Input video path
 * @param {string} options.outputPath - Output pattern (e.g., frame_%04d.jpg)
 * @param {number} options.fps - Frames per second (default: 1)
 * @param {number} options.maxDimension - Max dimension for frames (default: 1024)
 * @param {Function} options.onProgress - Progress callback
 * @param {AbortSignal} options.signal - Abort signal
 * 
 * @returns {Promise<{exitCode: number, stats: Object}>}
 */
export async function extractKeyframes({
  inputPath,
  outputPath,
  fps = 1,
  maxDimension = 1024,
  onProgress,
  signal,
}) {
  const platform = getGpuPlatform();
  const args = buildVideoArgs({
    mode: 'extract_keyframes',
    fps,
    maxDimension,
  });
  
  // For keyframe extraction, we typically want image2 output
  const outputArgs = [
    ...args,
    '-f', 'image2',
  ];
  
  // Use hardware accel for decoding only (filters are CPU for frames)
  if (platform !== GPU_PLATFORMS.CPU) {
    return runWithHwAccel({
      inputPath,
      outputPath,
      args: outputArgs,
      onProgress,
      signal,
    });
  }
  
  return run({
    inputPath,
    outputPath,
    args: outputArgs,
    onProgress,
    signal,
  });
}

/**
 * Get supported GPU platforms
 */
export { GPU_PLATFORMS, getGpuPlatform };

/**
 * Re-export parser utilities
 */
export { parseProgressLine, calculatePercent } from './parser.js';

/**
 * Re-export codec utilities
 */
export { 
  getVideoEncodeCodec, 
  getAudioCodec, 
  hasHardwareAccel,
  FORMAT_EXTENSIONS,
  MIME_TYPES,
} from './codecs.js';
