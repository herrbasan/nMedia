import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import config from '../config/config.js';
import logger from './logger.js';

/**
 * Decode HEIC/HEIF images using FFmpeg (for Apple-format HEIC that libvips can't handle).
 * @param {Buffer} input - Input image buffer
 * @returns {Promise<Buffer>} - Decoded PNG buffer
 */
export async function decodeHeicWithFFmpeg(input) {
  // Write input to temp file
  const tempDir = os.tmpdir();
  const inputFile = path.join(tempDir, `heic_input_${Date.now()}.heic`);
  const outputFile = path.join(tempDir, `heic_output_${Date.now()}.png`);

  try {
    fs.writeFileSync(inputFile, input);

    const ffmpegPath = config.ffmpegPath;
    if (!ffmpegPath) {
      throw new Error('FFmpeg path not configured');
    }

    // Use FFmpeg to decode HEIC to PNG
    execSync(`"${ffmpegPath}" -y -i "${inputFile}" "${outputFile}"`, {
      stdio: 'pipe'
    });

    const pngBuffer = fs.readFileSync(outputFile);
    return pngBuffer;
  } finally {
    // Cleanup temp files
    try {
      if (fs.existsSync(inputFile)) fs.unlinkSync(inputFile);
      if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile);
    } catch (e) {
      logger.debug('Temp file cleanup error', { error: e.message });
    }
  }
}

/**
 * Check if a buffer is likely a HEIC/HEIF image
 * @param {Buffer} buffer
 * @returns {boolean}
 */
export function isHeicBuffer(buffer) {
  if (!buffer || buffer.length < 12) return false;

  // Check for HEIC signature (ftyp box with heic/heif brand)
  // HEIC files start with ftyp, HEIF brand
  const signature = buffer.toString('hex', 4, 8);
  return signature === '66747970' && (
    buffer.toString('ascii', 8, 12).includes('heic') ||
    buffer.toString('ascii', 8, 12).includes('heif') ||
    buffer.toString('ascii', 8, 12).includes('mif1')
  );
}

/**
 * Detect image format from buffer
 * @param {Buffer} buffer
 * @returns {string|null}
 */
export function detectImageFormat(buffer) {
  if (!buffer || buffer.length < 12) return null;

  // PNG: 89 50 4E 47
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
    return 'png';
  }

  // JPEG: FF D8 FF
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
    return 'jpeg';
  }

  // GIF: 47 49 46 38
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) {
    return 'gif';
  }

  // WebP: RIFF .... WEBP
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
      buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
    return 'webp';
  }

  // HEIC/HEIF: ftyp with heic/heif/mif1 brand
  if (isHeicBuffer(buffer)) {
    return 'heic';
  }

  return null;
}