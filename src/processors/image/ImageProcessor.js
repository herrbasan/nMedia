import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import Processor from '../../pipeline/Processor.js';
import logger from '../../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load nImage from submodule
let nImage;
try {
  const nImagePath = path.join(__dirname, '../../../modules/nImage/lib/index.js');
  const nImageUrl = pathToFileURL(nImagePath).href;
  nImage = (await import(nImageUrl)).default;
} catch (e) {
  throw new Error(`nImage module not found. Run "git submodule update --init" and build nImage. Error: ${e.message}`);
}

/**
 * Image processor using nImage (native NAPI with libraw/libheif/ImageMagick support)
 * Supports: RAW (CR2, NEF, ARW, ORF, etc.), HEIC/HEIF, AVIF, and 150+ formats
 */
class ImageProcessor extends Processor {
  constructor() {
    super('image');
  }

  validateOptions(options) {
    const { max_dimension, quality, format, crop, rotate, flip, flop, grayscale, normalize, blur } = options;

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
  async processCrop(input, metadata, cropOptions, format, quality, onProgress, originalSize) {
    const { type, left, top, right, bottom, width: widthPercent, height: heightPercent, cols: gridCols, rows: gridRows, cells: gridCells = [] } = cropOptions;
    const results = [];

    if (type === 'region') {
      const leftPx = Math.round(left * metadata.width);
      const topPx = Math.round(top * metadata.height);
      const rightPx = Math.round(right * metadata.width);
      const bottomPx = Math.round(bottom * metadata.height);
      const cropWidth = rightPx - leftPx;
      const cropHeight = bottomPx - topPx;

      onProgress?.(30, `Cropping region ${leftPx}x${topPx} to ${cropWidth}x${cropHeight}`);
      const cropped = await nImage(input)
        .extract({ left: leftPx, top: topPx, width: cropWidth, height: cropHeight })
        .toBuffer();

      results.push({ index: null, buffer: cropped, bounds: { left: leftPx, top: topPx, width: cropWidth, height: cropHeight } });
    } else if (type === 'center') {
      const pct = widthPercent || 50;
      const heightPct = heightPercent || pct;
      const cropWidth = Math.round(metadata.width * (pct / 100));
      const cropHeight = Math.round(metadata.height * (heightPct / 100));
      const leftPx = Math.round((metadata.width - cropWidth) / 2);
      const topPx = Math.round((metadata.height - cropHeight) / 2);

      onProgress?.(30, `Center cropping to ${cropWidth}x${cropHeight}`);
      const cropped = await nImage(input)
        .extract({ left: leftPx, top: topPx, width: cropWidth, height: cropHeight })
        .toBuffer();

      results.push({ index: null, buffer: cropped, bounds: { left: leftPx, top: topPx, width: cropWidth, height: cropHeight } });
    } else if (type === 'grid') {
      const cols = gridCols || 3;
      const rows = gridRows || 3;
      const cells = gridCells.length > 0 ? gridCells : [];
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

        const cropped = await nImage(input)
          .extract({ left: leftPx, top: topPx, width: cellWidth, height: cellHeight })
          .toBuffer();

        results.push({ index: cellIndex, buffer: cropped, bounds: { left: leftPx, top: topPx, width: cellWidth, height: cellHeight } });
      }
    }

    onProgress?.(80, 'Encoding output');
    const encoded = await Promise.all(results.map(async (r) => {
      const encodedBuffer = await this.encodeBuffer(r.buffer, format, quality);
      return {
        cell_index: r.index,
        buffer: encodedBuffer,
        width: r.bounds.width,
        height: r.bounds.height,
      };
    }));

    onProgress?.(100, 'Complete');

    const firstBuffer = encoded[0]?.buffer || Buffer.alloc(0);

    return {
      buffer: firstBuffer,
      metadata: {
        originalSize: originalSize || (Buffer.isBuffer(input) ? input.length : 0),
        outputSize: firstBuffer.length,
        width: encoded[0]?.width,
        height: encoded[0]?.height,
        format,
        mimeType: `image/${format === 'jpeg' ? 'jpeg' : format}`,
        cropType: type,
        cropCount: encoded.length,
        crops: encoded.map((e, i) => ({
          index: e.cell_index ?? i,
          width: e.width,
          height: e.height,
          size: e.buffer.length,
        })),
        originalWidth: metadata.width,
        originalHeight: metadata.height,
      },
      extraBuffers: encoded.slice(1).map(e => e.buffer),
    };
  }

  /**
   * Encode buffer to target format
   */
  async encodeBuffer(buffer, format, quality) {
    const pipeline = nImage(buffer);
    const avifQuality = Math.round(quality * 0.55);
    switch (format) {
      case 'jpeg':
        pipeline.jpeg({ quality });
        break;
      case 'png':
        pipeline.png({ quality });
        break;
      case 'webp':
        pipeline.webp({ quality });
        break;
      case 'avif':
        pipeline.avif({ quality: avifQuality });
        break;
      case 'gif':
        // nImage doesn't support GIF output directly, use PNG
        pipeline.png({ quality });
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
      rotate = null,
      flip = false,
      flop = false,
      grayscale = false,
      normalize = false,
      blur = 0,
      _inputSource,
    } = options;

    const parsedRotate = rotate ? parseInt(rotate) : null;

    let inputSource = input;
    let originalSize;

    // Path-based input
    if (_inputSource === 'path' && typeof input === 'string' && fs.existsSync(input)) {
      const stat = fs.statSync(input);
      originalSize = stat.size;
      inputSource = input;
    } else if (Buffer.isBuffer(input)) {
      originalSize = input.length;
      inputSource = input;
    } else {
      throw new Error('Invalid image input: must be file path or buffer');
    }

    onProgress?.(5, 'Loading image');
    onProgress?.(10, 'Decoding image (nImage)');

    const metadata = await nImage(inputSource).metadata();
    onProgress?.(15, `Detected: ${metadata.format || 'unknown'}, ${metadata.width}x${metadata.height}`);

    if (crop) {
      return this.processCrop(inputSource, metadata, crop, format, quality, onProgress, originalSize);
    }

    let pipeline = nImage(inputSource);

    // Apply transforms
    if (parsedRotate) {
      onProgress?.(20, `Rotating ${parsedRotate}°`);
      pipeline.rotate(parsedRotate);
    }

    if (flip) {
      onProgress?.(22, 'Flipping vertically');
      pipeline.flip();
    }

    if (flop) {
      onProgress?.(24, 'Flopping horizontally');
      pipeline.flop();
    }

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
      pipeline.resize(width, height, { fit: 'inside' });
    }

    if (grayscale) {
      onProgress?.(40, 'Converting to grayscale');
      pipeline.grayscale();
    }

    if (normalize) {
      onProgress?.(45, 'Normalizing contrast');
      pipeline.normalize();
    }

    if (blur > 0) {
      onProgress?.(48, `Applying blur (sigma: ${blur})`);
      pipeline.blur(blur);
    }

    if (!strip_exif) {
      onProgress?.(50, 'Processing metadata');
    } else {
      onProgress?.(50, 'Stripping metadata');
    }

    onProgress?.(70, `Converting to ${format}`);
    const avifQuality = Math.round(quality * 0.55);
    switch (format) {
      case 'jpeg':
        pipeline.jpeg({ quality });
        break;
      case 'png':
        pipeline.png({ quality });
        break;
      case 'webp':
        pipeline.webp({ quality });
        break;
      case 'avif':
        pipeline.avif({ quality: avifQuality });
        break;
      case 'gif':
        pipeline.png({ quality });
        break;
    }

    onProgress?.(85, 'Encoding output');
    const outputBuffer = await pipeline.toBuffer();

    const outputMetadata = await nImage(outputBuffer).metadata();

    logger.info('Image processed', {
      originalSize,
      outputSize: outputBuffer.length,
      dimensions: `${outputMetadata.width}x${outputMetadata.height}`,
      format,
      transforms: { rotate, flip, flop, grayscale, normalize, blur },
    });

    onProgress?.(100, 'Complete');

    return {
      buffer: outputBuffer,
      metadata: {
        originalSize,
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
