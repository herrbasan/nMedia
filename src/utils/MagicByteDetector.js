/**
 * Magic byte detection for file type validation.
 * Prevents malformed input from reaching native modules.
 */
export class MagicByteDetector {
  /**
   * Detect media type from file buffer.
   * @param {Buffer} buffer - First bytes of file
   * @returns {{ type: string, mimeType: string }|null}
   */
  static detect(buffer) {
    if (!buffer || buffer.length < 4) return null;

    const hex = buffer.slice(0, 16).toString('hex').toUpperCase();

    // Images
    if (hex.startsWith('FFD8FF')) return { type: 'image', mimeType: 'image/jpeg' };
    if (hex.startsWith('89504E47')) return { type: 'image', mimeType: 'image/png' };
    if (hex.startsWith('47494638')) return { type: 'image', mimeType: 'image/gif' };
    if (hex.startsWith('52494646') && hex.slice(16, 24) === '57454250') return { type: 'image', mimeType: 'image/webp' };
    if (hex.startsWith('0000000C6A502020')) return { type: 'image', mimeType: 'image/jp2' };
    if (hex.startsWith('000000186674797061766966')) return { type: 'image', mimeType: 'image/avif' };

    // HEIC/HEIF (ftyp heuristic)
    if (hex.startsWith('000000') && hex.includes('6674797068656963')) return { type: 'image', mimeType: 'image/heic' };
    if (hex.startsWith('000000') && hex.includes('667479706D696631')) return { type: 'image', mimeType: 'image/heif' };

    // Audio
    if (hex.startsWith('494433') || hex.startsWith('FF')) return { type: 'audio', mimeType: 'audio/mpeg' };
    if (hex.startsWith('52494646') && hex.slice(16, 24) === '57415645') return { type: 'audio', mimeType: 'audio/wav' };
    if (hex.startsWith('4F676753')) return { type: 'audio', mimeType: 'audio/ogg' };
    if (hex.startsWith('664C6143')) return { type: 'audio', mimeType: 'audio/flac' };

    // Video / Container formats (MP4, MOV, M4A, etc.)
    if (hex.startsWith('000000') && hex.includes('66747970')) {
      const ftyp = hex.slice(16, 48);
      if (ftyp.includes('6D703431') || ftyp.includes('6D703432') || ftyp.includes('69736F6D') || ftyp.includes('6D7034')) {
        return { type: 'video', mimeType: 'video/mp4' };
      }
      if (ftyp.includes('71742020') || ftyp.includes('4D344120')) {
        return { type: 'video', mimeType: 'video/quicktime' };
      }
      if (ftyp.includes('6D346120') || ftyp.includes('4D344120')) {
        return { type: 'audio', mimeType: 'audio/mp4' };
      }
      if (ftyp.includes('61766331') || ftyp.includes('68766331')) {
        return { type: 'video', mimeType: 'video/mp4' };
      }
      return { type: 'video', mimeType: 'video/mp4' };
    }

    // WebM / MKV
    if (hex.startsWith('1A45DFA3')) {
      return { type: 'video', mimeType: 'video/webm' };
    }

    // AVI
    if (hex.startsWith('52494646') && hex.slice(16, 24) === '41564920') {
      return { type: 'video', mimeType: 'video/avi' };
    }

    // FLAC (also audio)
    if (hex.startsWith('664C6143')) {
      return { type: 'audio', mimeType: 'audio/flac' };
    }

    return null;
  }

  /**
   * Validate that detected type matches expected type.
   * @param {string} expected - Expected type ('image', 'audio', 'video')
   * @param {Object} detected - Result from detect()
   * @returns {boolean}
   */
  static matches(expected, detected) {
    if (!detected) return false;
    return detected.type === expected;
  }
}
