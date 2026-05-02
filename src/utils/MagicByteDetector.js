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

    // TIFF-based RAW formats (CR2, ORF, NEF, DNG, ARW, etc.)
    if (hex.startsWith('49492A00') || hex.startsWith('4D4D002A')) return { type: 'image', mimeType: 'image/tiff' };
    if (hex.startsWith('4949524F')) return { type: 'image', mimeType: 'image/orf' };

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
      if (ftyp.includes('6D346120') || ftyp.includes('4D344120') || ftyp.includes('6D346220') || ftyp.includes('4D344220')) {
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

    return null;
  }

  static detectFromExtension(filename) {
    if (!filename) return null;
    const ext = filename.split('.').pop().toLowerCase();
    const map = {
      jpg: { type: 'image', mimeType: 'image/jpeg' },
      jpeg: { type: 'image', mimeType: 'image/jpeg' },
      png: { type: 'image', mimeType: 'image/png' },
      gif: { type: 'image', mimeType: 'image/gif' },
      webp: { type: 'image', mimeType: 'image/webp' },
      avif: { type: 'image', mimeType: 'image/avif' },
      tiff: { type: 'image', mimeType: 'image/tiff' },
      tif: { type: 'image', mimeType: 'image/tiff' },
      bmp: { type: 'image', mimeType: 'image/bmp' },
      heic: { type: 'image', mimeType: 'image/heic' },
      heif: { type: 'image', mimeType: 'image/heif' },
      cr2: { type: 'image', mimeType: 'image/x-canon-cr2' },
      cr3: { type: 'image', mimeType: 'image/x-canon-cr3' },
      nef: { type: 'image', mimeType: 'image/x-nikon-nef' },
      arw: { type: 'image', mimeType: 'image/x-sony-arw' },
      dng: { type: 'image', mimeType: 'image/x-adobe-dng' },
      orf: { type: 'image', mimeType: 'image/x-olympus-orf' },
      raf: { type: 'image', mimeType: 'image/x-fuji-raf' },
      rw2: { type: 'image', mimeType: 'image/x-panasonic-rw2' },
      peF: { type: 'image', mimeType: 'image/x-pentax-pef' },
      sr2: { type: 'image', mimeType: 'image/x-sony-sr2' },
      mp3: { type: 'audio', mimeType: 'audio/mpeg' },
      wav: { type: 'audio', mimeType: 'audio/wav' },
      ogg: { type: 'audio', mimeType: 'audio/ogg' },
      flac: { type: 'audio', mimeType: 'audio/flac' },
      m4a: { type: 'audio', mimeType: 'audio/mp4' },
      m4b: { type: 'audio', mimeType: 'audio/mp4' },
      aac: { type: 'audio', mimeType: 'audio/aac' },
      wma: { type: 'audio', mimeType: 'audio/x-ms-wma' },
      mp4: { type: 'video', mimeType: 'video/mp4' },
      mov: { type: 'video', mimeType: 'video/quicktime' },
      avi: { type: 'video', mimeType: 'video/avi' },
      mkv: { type: 'video', mimeType: 'video/x-matroska' },
      webm: { type: 'video', mimeType: 'video/webm' },
      wmv: { type: 'video', mimeType: 'video/x-ms-wmv' },
      m4v: { type: 'video', mimeType: 'video/mp4' },
      ts: { type: 'video', mimeType: 'video/mp2t' },
      mts: { type: 'video', mimeType: 'video/mp2t' },
      '3gp': { type: 'video', mimeType: 'video/3gpp' },
    };
    return map[ext] || null;
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
