import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from '../../utils/uuid.js';
import Processor from '../../pipeline/Processor.js';
import config from '../../config/config.js';
import logger from '../../utils/logger.js';
import { extractAudio, extractKeyframes, FORMAT_EXTENSIONS } from '../../utils/ffmpeg/index.js';

/**
 * Video processor using FFmpeg CLI wrapper
 * Supports extracting audio or keyframes with GPU acceleration
 */
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
    const {
      mode = 'extract_audio',
      fps = 1,
    } = options;

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
    const outputPath = path.join(config.cacheDir, `output-${outputId}.${FORMAT_EXTENSIONS[format] || format}`);

    try {
      onProgress?.(10, 'Preparing video');

      // Write input buffer to temp file
      fs.writeFileSync(inputPath, input);

      onProgress?.(15, 'Extracting audio track');

      // Extract audio with FFmpeg
      const result = await extractAudio({
        inputPath,
        outputPath,
        format,
        onProgress: (percent, metadata) => {
          // Map FFmpeg progress (0-100) to our range (15-90)
          const mappedPercent = 15 + Math.round(percent * 0.75);
          onProgress?.(mappedPercent, `Extracting: ${Math.round(percent)}%`);
        },
      });

      onProgress?.(90, 'Reading output');

      // Read output file
      const outputBuffer = fs.readFileSync(outputPath);

      // Clean up temp files
      try {
        fs.unlinkSync(inputPath);
      } catch (err) {
        logger.debug('Failed to clean up input file', { error: err.message });
      }
      try {
        fs.unlinkSync(outputPath);
      } catch (err) {
        logger.debug('Failed to clean up output file', { error: err.message });
      }

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
          mimeType: 'audio/mpeg',
        },
      };
    } catch (error) {
      // Clean up temp files on error
      try { fs.unlinkSync(inputPath); } catch {}
      try { fs.unlinkSync(outputPath); } catch {}
      
      logger.error('Video audio extraction error', { error: error.message });
      throw error;
    }
  }

  async extractKeyframes(input, options, onProgress) {
    const { fps = 1, format = 'jpeg', max_dimension = 1024 } = options;

    const inputId = uuidv4();
    const outputId = uuidv4();
    
    const inputExt = this._detectInputExtension(input);
    const inputPath = path.join(config.cacheDir, `input-${inputId}.${inputExt}`);
    
    // For keyframes, we use a directory and collect all frames
    const outputDir = path.join(config.cacheDir, `frames-${outputId}`);
    const outputPattern = path.join(outputDir, 'frame_%04d.jpg');

    try {
      onProgress?.(10, 'Preparing video');

      // Create output directory
      fs.mkdirSync(outputDir, { recursive: true });

      // Write input buffer to temp file
      fs.writeFileSync(inputPath, input);

      onProgress?.(15, `Extracting keyframes at ${fps} fps`);

      // Extract keyframes with FFmpeg
      const result = await extractKeyframes({
        inputPath,
        outputPath: outputPattern,
        fps,
        maxDimension: max_dimension,
        onProgress: (percent, metadata) => {
          // Map FFmpeg progress (0-100) to our range (15-85)
          const mappedPercent = 15 + Math.round(percent * 0.7);
          onProgress?.(mappedPercent, `Extracted ${metadata.frame || 0} frames`);
        },
      });

      onProgress?.(85, 'Collecting frames');

      // Read all extracted frames
      const frameFiles = fs.readdirSync(outputDir)
        .filter(f => f.endsWith('.jpg'))
        .sort();

      const frameCount = frameFiles.length;
      
      if (frameCount === 0) {
        throw new Error('No frames were extracted from the video');
      }

      // For now, return the first frame as the result
      // Future: Could return a ZIP of all frames or a sprite sheet
      const firstFramePath = path.join(outputDir, frameFiles[0]);
      const outputBuffer = fs.readFileSync(firstFramePath);

      // Clean up temp files and directory
      try {
        fs.unlinkSync(inputPath);
      } catch (err) {
        logger.debug('Failed to clean up input file', { error: err.message });
      }
      
      // Clean up output directory and all frames
      try {
        for (const file of frameFiles) {
          fs.unlinkSync(path.join(outputDir, file));
        }
        fs.rmdirSync(outputDir);
      } catch (err) {
        logger.debug('Failed to clean up frames directory', { error: err.message });
      }

      onProgress?.(100, 'Complete');

      logger.info('Keyframes extracted from video', {
        originalSize: input.length,
        frameCount,
        outputSize: outputBuffer.length,
      });

      return {
        buffer: outputBuffer,
        metadata: {
          originalSize: input.length,
          frameCount,
          mode: 'extract_keyframes',
          format,
          fps,
          maxDimension: max_dimension,
          mimeType: 'image/jpeg',
        },
      };
    } catch (error) {
      // Clean up temp files on error
      try { fs.unlinkSync(inputPath); } catch {}
      try {
        if (fs.existsSync(outputDir)) {
          const files = fs.readdirSync(outputDir);
          for (const file of files) {
            fs.unlinkSync(path.join(outputDir, file));
          }
          fs.rmdirSync(outputDir);
        }
      } catch {}
      
      logger.error('Video keyframe extraction error', { error: error.message });
      throw error;
    }
  }

  /**
   * Detect input file extension from buffer magic bytes
   * @param {Buffer} buffer
   * @returns {string}
   */
  _detectInputExtension(buffer) {
    if (buffer.length < 12) return 'bin';
    
    const magic = buffer.slice(0, 12).toString('hex').toUpperCase();
    
    // MP4 (ftyp)
    if (buffer.slice(4, 8).toString('hex').toUpperCase() === '66747970') {
      // Check for specific brands
      const brand = buffer.slice(8, 12).toString('ascii');
      if (brand.startsWith('qt')) return 'mov';
      return 'mp4';
    }
    
    // WebM (matroska)
    if (magic.startsWith('1A45DFA3')) return 'webm';
    
    // AVI (RIFF....AVI )
    if (magic.startsWith('52494646') && magic.includes('41564920')) return 'avi';
    
    // MKV (matroska)
    if (magic.startsWith('1A45DFA3')) return 'mkv';
    
    // MOV (ftypqt)
    if (buffer.slice(4, 10).toString('ascii') === 'ftypqt') return 'mov';
    
    return 'bin';
  }
}

export default VideoProcessor;
