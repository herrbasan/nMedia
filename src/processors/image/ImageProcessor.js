import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath, pathToFileURL } from 'url';
import Processor from '../../pipeline/Processor.js';
import logger, { logError } from '../../utils/logger.js';
import { rejectUnknownImageOptions, rejectUnknownSvgShapeKeys } from '../validateOptions.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load nImage from submodule
let nImage;
let intrinsicSize;
try {
  const nImagePath = path.join(__dirname, '../../../modules/nImage/lib/index.js');
  const nImageUrl = pathToFileURL(nImagePath).href;
  nImage = (await import(nImageUrl)).default;
  // intrinsicSize lives in the renderer lib (viewBox preferred, then
  // width/height, else the documented 1024 default) — sharing it keeps the
  // max_dimension upscale math identical to what the renderer would do.
  intrinsicSize = (await import(pathToFileURL(path.join(__dirname, '../../../modules/nImage/lib/svg-renderer.js')).href)).intrinsicSize;
} catch (e) {
  throw new Error(`nImage module not found. Run "git submodule update --init" and build nImage. Error: ${e.message}`);
}

/**
 * Image processor using nImage (native NAPI with libraw/libheif/ImageMagick support)
 * Supports: RAW (CR2, NEF, ARW, ORF, etc.), HEIC/HEIF, AVIF, and 150+ formats
 */

// SVG raster sizing limits (see validateSvgShape)
const SVG_DENSITY_MAX = 32;
const SVG_DIMENSION_MAX = 10000;

/**
 * Validate the SVG raster shape shared by top-level options and options.svg.
 * Only defined keys are checked; absent keys fall back to renderer defaults.
 */
function validateSvgShape(shape) {
  if (shape.density !== undefined && (typeof shape.density !== 'number' || !Number.isFinite(shape.density) || shape.density <= 0 || shape.density > SVG_DENSITY_MAX)) {
    throw new Error(`density must be a number between 0 (exclusive) and ${SVG_DENSITY_MAX}`);
  }
  for (const key of ['width', 'height']) {
    const value = shape[key];
    if (value !== undefined && (!Number.isInteger(value) || value <= 0 || value > SVG_DIMENSION_MAX)) {
      throw new Error(`${key} must be an integer between 1 and ${SVG_DIMENSION_MAX}`);
    }
  }
  const scheme = shape.colorScheme !== undefined ? shape.colorScheme : shape.color_scheme;
  if (scheme !== undefined && !['light', 'dark'].includes(scheme)) {
    throw new Error("colorScheme must be 'light' or 'dark'");
  }
  if (shape.transparent !== undefined && typeof shape.transparent !== 'boolean') {
    throw new Error('transparent must be a boolean');
  }
}

/**
 * Merge SVG raster options from top-level (density, width, height, colorScheme,
 * color_scheme, transparent) and options.svg; top-level wins on conflict.
 * Only defined keys are emitted, so the renderer's defaults apply to the rest.
 */
function mergeSvgOptions(options) {
  const svg = typeof options.svg === 'object' && options.svg !== null ? options.svg : {};
  const pick = (...candidates) => candidates.find((value) => value !== undefined);
  const merged = {};
  const width = pick(options.width, svg.width);
  const height = pick(options.height, svg.height);
  const density = pick(options.density, svg.density);
  const colorScheme = pick(options.colorScheme, options.color_scheme, svg.colorScheme, svg.color_scheme);
  const transparent = pick(options.transparent, svg.transparent);
  if (width !== undefined) merged.width = width;
  if (height !== undefined) merged.height = height;
  if (density !== undefined) merged.density = density;
  if (colorScheme !== undefined) merged.colorScheme = colorScheme;
  if (transparent !== undefined) merged.transparent = transparent;
  return merged;
}

/**
 * SVG prolog sniff — SVG is XML text with no magic bytes. Mirrors nImage's own
 * detection and MagicByteDetector: gzip container (svgz) unwrapped first, then
 * an <svg> tag behind an xml/svg/doctype prolog.
 */
function sniffSvgProlog(buffer) {
  if (buffer.length < 2) return false;
  if (buffer[0] === 0x1f && buffer[1] === 0x8b) {
    try {
      // Z_SYNC_FLUSH accepts a head-only prefix of a larger gzip stream.
      return /<svg[\s>]/i.test(zlib.gunzipSync(buffer, { finishFlush: zlib.constants.Z_SYNC_FLUSH }).toString('utf8'));
    } catch (e) {
      // A stream that cannot be decompressed is not an SVG we can render.
      logger.warn('SVG prolog sniff: gunzip failed', { bytes: buffer.length, error: e.message });
      return false;
    }
  }
  const head = buffer.subarray(0, 4096).toString('utf8').replace(/^\uFEFF/, '');
  return /<svg[\s>]/i.test(head) && /^\s*(<\?xml|<svg|<!DOCTYPE\s+svg)/i.test(head);
}

/**
 * Detect SVG input. Returns 'svg', 'svgz', or null.
 * Buffers go through nImage.detectFormat with a prolog-sniff fallback; file
 * paths are matched by extension, then by sniffing the first 4 KiB.
 */
function detectSvgSource(inputSource) {
  if (Buffer.isBuffer(inputSource)) {
    const format = nImage.detectFormat(inputSource).format;
    if (format === 'svg' || format === 'svgz') return format;
    return sniffSvgProlog(inputSource) ? 'svg' : null;
  }
  if (typeof inputSource === 'string') {
    const ext = path.extname(inputSource).slice(1).toLowerCase();
    if (ext === 'svg' || ext === 'svgz') return ext;
    const fd = fs.openSync(inputSource, 'r');
    try {
      const head = Buffer.alloc(4096);
      const read = fs.readSync(fd, head, 0, 4096, 0);
      return sniffSvgProlog(head.subarray(0, read)) ? 'svg' : null;
    } finally {
      fs.closeSync(fd);
    }
  }
  return null;
}

/**
 * SVG markup as text (svgz unwrapped) for intrinsic-size parsing.
 */
function svgMarkup(inputSource, kind) {
  let buffer = Buffer.isBuffer(inputSource) ? inputSource : fs.readFileSync(inputSource);
  if (kind === 'svgz') buffer = zlib.gunzipSync(buffer);
  return buffer.toString('utf8');
}

/**
 * Parse the background option into sharp's {r,g,b,alpha} object. Hex and
 * rgb()/rgba() only: sharp's own background parser silently falls back to
 * black on strings it cannot read (e.g. 'rgb(24,24,24)'), and a silent
 * default canvas is exactly the failure mode this service rejects (#8/#9).
 */
function parseBackground(value) {
  const clamp = (n) => Math.max(0, Math.min(255, Math.round(n)));
  let m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value);
  if (m) {
    const hex = m[1];
    const short = hex.length === 3 || hex.length === 4;
    const part = (i) => parseInt(short ? hex[i] + hex[i] : hex.substr(i * 2, 2), 16);
    const alpha = (hex.length === 4 || hex.length === 8) ? part(3) / 255 : 1;
    return { r: part(0), g: part(1), b: part(2), alpha };
  }
  m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(value);
  if (m) {
    const alpha = m[4] !== undefined ? Math.max(0, Math.min(1, parseFloat(m[4]))) : 1;
    return { r: clamp(+m[1]), g: clamp(+m[2]), b: clamp(+m[3]), alpha };
  }
  throw new Error(`background must be a hex (#rgb/#rrggbb/#rrggbbaa) or rgb()/rgba() colour, or "transparent" (got '${value}')`);
}

class ImageProcessor extends Processor {
  constructor() {
    super('image');
  }

  validateOptions(options) {
    const { max_dimension, quality, format, crop, rotate, flip, flop, grayscale, normalize, blur, density, width, height, colorScheme, color_scheme, transparent, background, svg } = options;

    rejectUnknownImageOptions(options);

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

    validateSvgShape({ density, width, height, colorScheme, color_scheme, transparent });

    if (background !== undefined) {
      if (typeof background !== 'string' || background.length === 0) {
        throw new Error('background must be a non-empty CSS colour string or "transparent"');
      }
      // Parse at validation time so a bad colour is a 400, not a job failure.
      if (background !== 'transparent') parseBackground(background);
      // transparent:false bakes an opaque white canvas at render time;
      // flatten over a fully opaque raster is a no-op, so the caller's
      // background would silently not apply.
      const opaqueCanvas = transparent === false || (svg !== undefined && svg.transparent === false);
      if (background !== 'transparent' && opaqueCanvas) {
        throw new Error('background and transparent:false conflict — background composites over alpha, transparent:false removes alpha at render');
      }
    }

    if (svg !== undefined) {
      if (typeof svg !== 'object' || svg === null || Array.isArray(svg)) {
        throw new Error('svg must be an object');
      }
      rejectUnknownSvgShapeKeys(svg);
      validateSvgShape(svg);
    }
  }

  /**
   * Build the nImage pipeline options for SVG raster sizing.
   *
   * For SVG input the raster size is fixed at render time by the renderer
   * (Chrome draws vectors at any resolution): explicit width/height/density
   * are forwarded as given, otherwise max_dimension becomes the upscale
   * target — the longest intrinsic edge is scaled to it, proportionally.
   * Returns {} for non-SVG input so pipelines behave exactly as before.
   */
  _svgRasterOptions(inputSource, options, maxDimension, onProgress) {
    const kind = detectSvgSource(inputSource);
    if (kind === null) return {};

    const svgOptions = mergeSvgOptions(options);
    if (svgOptions.width === undefined && svgOptions.height === undefined && svgOptions.density === undefined) {
      const intrinsic = intrinsicSize(svgMarkup(inputSource, kind));
      const scale = maxDimension / Math.max(intrinsic.width, intrinsic.height);
      svgOptions.width = Math.max(1, Math.round(intrinsic.width * scale));
      svgOptions.height = Math.max(1, Math.round(intrinsic.height * scale));
      onProgress?.(12, `SVG raster target: ${svgOptions.width}x${svgOptions.height}`);
    }
    return { svg: svgOptions };
  }

  /**
   * Process crop operations
   */
  async processCrop(input, metadata, cropOptions, format, quality, onProgress, originalSize, nImageOptions = {}, background = null) {
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
      const cropped = await nImage(input, nImageOptions)
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
      const cropped = await nImage(input, nImageOptions)
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

        const cropped = await nImage(input, nImageOptions)
          .extract({ left: leftPx, top: topPx, width: cellWidth, height: cellHeight })
          .toBuffer();

        results.push({ index: cellIndex, buffer: cropped, bounds: { left: leftPx, top: topPx, width: cellWidth, height: cellHeight } });
      }
    }

    onProgress?.(80, 'Encoding output');
    const encoded = await Promise.all(results.map(async (r) => {
      const encodedBuffer = await this.encodeBuffer(r.buffer, format, quality, background);
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
  async encodeBuffer(buffer, format, quality, background = null) {
    const pipeline = nImage(buffer);
    if (background && background !== 'transparent') {
      pipeline.flatten({ background: parseBackground(background) });
    }
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
    try {
      return await this._process(input, options, onProgress);
    } catch (error) {
      logError('Image processing failed', error, {
        inputType: Buffer.isBuffer(input) ? 'buffer' : 'path',
        inputBytes: Buffer.isBuffer(input) ? input.length : null,
        options: {
          max_dimension: options.max_dimension,
          quality: options.quality,
          format: options.format,
          crop: options.crop?.type,
          rotate: options.rotate,
          grayscale: options.grayscale,
          blur: options.blur,
          svg: options.svg,
          density: options.density,
          width: options.width,
          height: options.height,
          colorScheme: options.colorScheme !== undefined ? options.colorScheme : options.color_scheme,
          transparent: options.transparent,
          background: options.background,
        },
      });
      throw error;
    }
  }

  async _process(input, options = {}, onProgress) {
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
      background = null,
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

    // SVG options fix the raster size/color scheme at render time. The
    // pipeline created here is reused for every later operation: creating a
    // second nImage(inputSource) would make headless Chrome render the SVG a
    // second time.
    const nImageOptions = this._svgRasterOptions(inputSource, options, max_dimension, onProgress);
    const isSvg = nImageOptions.svg !== undefined;
    const pipeline = nImage(inputSource, nImageOptions);
    const metadata = await pipeline.metadata();
    onProgress?.(15, isSvg
      ? `SVG rasterized to ${metadata.width}x${metadata.height}`
      : `Detected: ${metadata.format || 'unknown'}, ${metadata.width}x${metadata.height}`);

    if (crop) {
      return this.processCrop(inputSource, metadata, crop, format, quality, onProgress, originalSize, nImageOptions, background);
    }

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
    // SVG rasters are sized by the renderer itself (explicit width/height/
    // density, or max_dimension applied to the intrinsic size at render time);
    // a later resize would shrink an explicitly requested size back down.
    const needsResize = !isSvg && (width > max_dimension || height > max_dimension);

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

    // Composite alpha onto the requested canvas colour (#9). Applied after
    // all transforms so the canvas keeps the exact colour asked for;
    // 'transparent' is the explicit no-op that preserves alpha.
    if (background && background !== 'transparent') {
      onProgress?.(55, `Flattening onto ${background}`);
      pipeline.flatten({ background: parseBackground(background) });
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
