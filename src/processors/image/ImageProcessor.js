import sharp from 'sharp';
import Processor from '../../pipeline/Processor.js';
import logger from '../../utils/logger.js';
import { decodeHeicWithFFmpeg, detectImageFormat } from '../../utils/HeifDecoder.js';

/**
 * Image processor using sharp (libvips)
 */
class ImageProcessor extends Processor {
  constructor() {
    super('image');
  }

  validateOptions(options) {
    const { max_dimension, quality, format, crop } = options;

    if (max_dimension !== undefined && (max_dimension < 1 || max_dimension > 10000)) {
      throw new Error('max_dimension must be between 1 and 10000');
    }
    if (quality !== undefined && (quality < 1 || quality > 100)) {
      throw new Error('quality must be between 1 and 100');
    }
    if (format !== undefined && !['jpeg', 'png', 'webp', 'avif', 'gif'].includes(format)) {
      throw new Error('format must be jpeg, png, webp, avif, or gif');
    }
    if (crop !== undefined) {
      if (typeof crop !== 'object') {
        throw new Error('crop must be an object');
      }
      const { type } = crop;
      if (!['region', 'center', 'grid'].includes(type)) {
        throw new Error('crop.type must be "region", "center", or "grid"');
      }
    }
  }

  /**
   * Process crop operations
   */
  async processCrop(input, metadata, cropOptions, format, quality, onProgress) {
    const { type, left, top, right, bottom, width: widthPercent, height: heightPercent, grid } = cropOptions;
    const results = [];

    if (type === 'region') {
      // Normalized region crop
      const leftPx = Math.round(left * metadata.width);
      const topPx = Math.round(top * metadata.height);
      const rightPx = Math.round(right * metadata.width);
      const bottomPx = Math.round(bottom * metadata.height);
      const cropWidth = rightPx - leftPx;
      const cropHeight = bottomPx - topPx;

      onProgress?.(30, `Cropping region ${leftPx}x${topPx} to ${cropWidth}x${cropHeight}`);
      const cropped = await sharp(input)
        .extract({ left: leftPx, top: topPx, width: cropWidth, height: cropHeight })
        .toBuffer();

      results.push({ index: null, buffer: cropped, bounds: { left: leftPx, top: topPx, width: cropWidth, height: cropHeight } });
    } else if (type === 'center') {
      // Center crop by percentage
      const pct = widthPercent || 50;
      const heightPct = heightPercent || pct;
      const cropWidth = Math.round(metadata.width * (pct / 100));
      const cropHeight = Math.round(metadata.height * (heightPct / 100));
      const leftPx = Math.round((metadata.width - cropWidth) / 2);
      const topPx = Math.round((metadata.height - cropHeight) / 2);

      onProgress?.(30, `Center cropping to ${cropWidth}x${cropHeight}`);
      const cropped = await sharp(input)
        .extract({ left: leftPx, top: topPx, width: cropWidth, height: cropHeight })
        .toBuffer();

      results.push({ index: null, buffer: cropped, bounds: { left: leftPx, top: topPx, width: cropWidth, height: cropHeight } });
    } else if (type === 'grid') {
      // Grid-based crop
      const { cols, rows, cells = [] } = grid;
      const cellWidth = Math.floor(metadata.width / cols);
      const cellHeight = Math.floor(metadata.height / rows);

      onProgress?.(20, `Grid ${cols}x${rows}, extracting ${cells.length} cells`);

      for (let i = 0; i < cells.length; i++) {
        const cellIndex = cells[i];
        const col = cellIndex % cols;
        const row = Math.floor(cellIndex / cols);
        const leftPx = col * cellWidth;
        const topPx = row * cellHeight;

        onProgress?.(20 + Math.round((i / cells.length) * 60), `Extracting cell ${cellIndex} at (${leftPx},${topPx})`);

        const cropped = await sharp(input)
          .extract({ left: leftPx, top: topPx, width: cellWidth, height: cellHeight })
          .toBuffer();

        results.push({ index: cellIndex, buffer: cropped, bounds: { left: leftPx, top: topPx, width: cellWidth, height: cellHeight } });
      }
    }

    // Encode all results
    onProgress?.(80, 'Encoding output');
    const encoded = await Promise.all(results.map(async (r) => {
      const encodedBuffer = await this.encodeBuffer(r.buffer, format, quality);
      return {
        cell_index: r.index,
        base64: `data:image/${format === 'jpeg' ? 'jpeg' : format};base64,${encodedBuffer.toString('base64')}`,
        width: r.bounds.width,
        height: r.bounds.height,
      };
    }));

    onProgress?.(100, 'Complete');

    return {
      buffer: encoded[0]?.base64 || null,
      metadata: {
        originalSize: input.length,
        crops: encoded,
        format,
        originalWidth: metadata.width,
        originalHeight: metadata.height,
      },
    };
  }

  /**
   * Encode buffer to target format
   */
  async encodeBuffer(buffer, format, quality) {
    let pipeline = sharp(buffer);
    switch (format) {
      case 'jpeg':
        pipeline = pipeline.jpeg({ quality });
        break;
      case 'png':
        pipeline = pipeline.png({ quality });
        break;
      case 'webp':
        pipeline = pipeline.webp({ quality });
        break;
      case 'avif':
        pipeline = pipeline.avif({ quality });
        break;
      case 'gif':
        pipeline = pipeline.gif();
        break;
    }
    return pipeline.toBuffer();
  }

  async process(input, options = {}, onProgress) {
    const {
      max_dimension = 1024,
      quality = 85,
      format = 'jpeg',
      strip_exif = true,
      crop = null,
    } = options;

    onProgress?.(5, 'Loading image');

    // Detect input format
    const detectedFormat = detectImageFormat(input);
    onProgress?.(10, `Detected format: ${detectedFormat || 'unknown'}`);

    // Handle HEIC format - libvips can't decode Apple's HEIC, use FFmpeg
    let processedInput = input;
    if (detectedFormat === 'heic') {
      onProgress?.(15, 'Decoding HEIC via FFmpeg');
      processedInput = await decodeHeicWithFFmpeg(input);
      onProgress?.(20, 'HEIC decoded, processing image');
    }

    let pipeline = sharp(processedInput);

    // Get metadata for aspect ratio calculation
    const metadata = await pipeline.metadata();
    onProgress?.(15, 'Analyzing dimensions');

    // Handle crop operations
    if (crop) {
      return this.processCrop(input, metadata, crop, format, quality, onProgress);
    }

    // Calculate resize dimensions
    let width = metadata.width;
    let height = metadata.height;
    const needsResize = width > max_dimension || height > max_dimension;

    if (needsResize) {
      if (width > height) {
        height = Math.round((height / width) * max_dimension);
        width = max_dimension;
      } else {
        width = Math.round((width / height) * max_dimension);
        height = max_dimension;
      }

      onProgress?.(30, `Resizing to ${width}x${height}`);
      pipeline = pipeline.resize(width, height, { fit: 'inside' });
    }

    // Strip EXIF if requested
    if (strip_exif) {
      onProgress?.(50, 'Stripping metadata');
      pipeline = pipeline.rotate(); // Auto-rotate and strip EXIF
    }

    // Apply format and quality
    onProgress?.(70, `Converting to ${format}`);
    switch (format) {
      case 'jpeg':
        pipeline = pipeline.jpeg({ quality });
        break;
      case 'png':
        pipeline = pipeline.png({ quality });
        break;
      case 'webp':
        pipeline = pipeline.webp({ quality });
        break;
      case 'avif':
        pipeline = pipeline.avif({ quality });
        break;
      case 'gif':
        pipeline = pipeline.gif();
        break;
    }

    onProgress?.(85, 'Encoding output');
    const outputBuffer = await pipeline.toBuffer();

    const outputMetadata = await sharp(outputBuffer).metadata();

    logger.info('Image processed', {
      originalSize: input.length,
      outputSize: outputBuffer.length,
      dimensions: `${outputMetadata.width}x${outputMetadata.height}`,
      format,
    });

    onProgress?.(100, 'Complete');

    return {
      buffer: outputBuffer,
      metadata: {
        originalSize: input.length,
        outputSize: outputBuffer.length,
        width: outputMetadata.width,
        height: outputMetadata.height,
        format,
        mimeType: `image/${format === 'jpeg' ? 'jpeg' : format}`,
      },
    };
  }
}

export default ImageProcessor;
