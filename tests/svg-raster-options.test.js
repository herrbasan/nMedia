import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ImageProcessor from '../src/processors/image/ImageProcessor.js';
import nImage from '../modules/nImage/lib/index.js';
import { renderer } from '../modules/nImage/lib/svg-renderer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 400x200 intrinsic (viewBox), solid red — exact pixel checks are safe on it.
const SVG_400X200 = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200">' +
  '<rect width="400" height="200" fill="#ff0000"/>' +
  '</svg>'
);

// Same canvas, fill styled through CSS with a dark-scheme override.
const SVG_SCHEMED = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200">' +
  '<style>rect { fill: #888888; } @media (prefers-color-scheme: dark) { rect { fill: #000000; } }</style>' +
  '<rect width="400" height="200"/>' +
  '</svg>'
);

// Red square centered on an otherwise empty (transparent) canvas.
const SVG_TRANSPARENT = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200">' +
  '<rect x="150" y="50" width="100" height="100" fill="#ff0000"/>' +
  '</svg>'
);

async function renderPng(input, options) {
  const processor = new ImageProcessor();
  const result = await processor.process(input, { format: 'png', ...options });
  return result.buffer;
}

async function pixels(pngBuffer) {
  const meta = await nImage(pngBuffer).metadata();
  const raw = await nImage(pngBuffer).raw();
  return {
    width: meta.width,
    height: meta.height,
    channels: meta.channels,
    at(x, y) {
      const i = (y * meta.width + x) * meta.channels;
      return [...raw.subarray(i, i + meta.channels)];
    },
  };
}

test('validateOptions accepts valid SVG raster options', () => {
  const processor = new ImageProcessor();
  processor.validateOptions({});
  processor.validateOptions({
    density: 4,
    width: 1600,
    height: 800,
    colorScheme: 'dark',
    transparent: false,
    svg: { density: 2, width: 10, height: 20, colorScheme: 'light', color_scheme: 'dark', transparent: true },
  });
});

test('validateOptions rejects invalid SVG raster options', () => {
  const processor = new ImageProcessor();
  const cases = [
    [{ density: 0 }, /density/],
    [{ density: 32.5 }, /density/],
    [{ density: 'x' }, /density/],
    [{ width: 0 }, /width/],
    [{ width: 10001 }, /width/],
    [{ width: 10.5 }, /width/],
    [{ height: -1 }, /height/],
    [{ colorScheme: 'system' }, /colorScheme/],
    [{ color_scheme: 'auto' }, /colorScheme/],
    [{ transparent: 'yes' }, /transparent/],
    [{ svg: 'nope' }, /svg must be an object/],
    [{ svg: { density: 0 } }, /density/],
    [{ svg: { width: 10001 } }, /width/],
    [{ svg: { colorScheme: 'system' } }, /colorScheme/],
    [{ svg: { transparent: 1 } }, /transparent/],
  ];
  for (const [options, expected] of cases) {
    assert.throws(() => processor.validateOptions(options), expected, JSON.stringify(options));
  }
});

test('SVG rasterizes at intrinsic size when max_dimension equals it', async () => {
  const px = await pixels(await renderPng(SVG_400X200, { max_dimension: 400 }));
  assert.equal(px.width, 400);
  assert.equal(px.height, 200);
  // A fully opaque canvas is emitted as RGB (3 channels), no alpha.
  assert.deepEqual(px.at(10, 10).slice(0, 3), [255, 0, 0]);
});

test('SVG density 4 renders 400x200 at 1600x800', async () => {
  const px = await pixels(await renderPng(SVG_400X200, { density: 4 }));
  assert.equal(px.width, 1600);
  assert.equal(px.height, 800);
});

test('SVG explicit width/height renders 1600x800', async () => {
  const px = await pixels(await renderPng(SVG_400X200, { width: 1600, height: 800 }));
  assert.equal(px.width, 1600);
  assert.equal(px.height, 800);
});

test('SVG max_dimension 1920 upscales 400x200 to 1920x960', async () => {
  const px = await pixels(await renderPng(SVG_400X200, { max_dimension: 1920 }));
  assert.equal(px.width, 1920);
  assert.equal(px.height, 960);
});

test('options.svg merges with top-level options, top-level wins', async () => {
  const px = await pixels(await renderPng(SVG_400X200, { svg: { width: 800, height: 400 }, width: 1600, height: 800 }));
  assert.equal(px.width, 1600);
  assert.equal(px.height, 800);
});

test('path-based SVG input honors max_dimension upscale', async () => {
  const fixture = path.join(__dirname, 'assets', 'svg', 'rect-400x200.svg');
  const px = await pixels(await renderPng(fixture, { max_dimension: 1920, _inputSource: 'path' }));
  assert.equal(px.width, 1920);
  assert.equal(px.height, 960);
});

test('colorScheme dark applies the prefers-color-scheme dark branch', async () => {
  const light = await pixels(await renderPng(SVG_SCHEMED, {}));
  const dark = await pixels(await renderPng(SVG_SCHEMED, { colorScheme: 'dark' }));
  assert.deepEqual(light.at(200, 100).slice(0, 3), [136, 136, 136]);
  assert.deepEqual(dark.at(200, 100).slice(0, 3), [0, 0, 0]);
});

test('transparent: false produces an opaque canvas', async () => {
  // max_dimension 400 keeps the raster at 1:1 so pixel coordinates map to the
  // SVG coordinate system. Transparent pixels carry undefined RGB — only
  // alpha is asserted on them.
  const transparent = await pixels(await renderPng(SVG_TRANSPARENT, { max_dimension: 400 }));
  const opaque = await pixels(await renderPng(SVG_TRANSPARENT, { max_dimension: 400, transparent: false }));
  assert.equal(transparent.width, 400);
  assert.equal(transparent.height, 200);
  assert.equal(transparent.channels, 4);
  assert.equal(transparent.at(5, 5)[3], 0);
  // Opaque canvas: Chrome emits RGB without an alpha channel.
  assert.equal(opaque.channels, 3);
  assert.deepEqual(opaque.at(5, 5), [255, 255, 255]);
  assert.deepEqual(transparent.at(200, 100), [255, 0, 0, 255]);
});

test('background composites transparent canvas onto the colour (#9)', async () => {
  const px = await pixels(await renderPng(SVG_TRANSPARENT, { max_dimension: 400, background: '#00ff00' }));
  // Flatten removes the alpha channel: the whole canvas is opaque.
  assert.equal(px.channels, 3);
  assert.deepEqual(px.at(5, 5), [0, 255, 0]);
  assert.deepEqual(px.at(200, 100), [255, 0, 0]);
});

test("background 'transparent' is the explicit alpha-preserving no-op", async () => {
  const px = await pixels(await renderPng(SVG_TRANSPARENT, { max_dimension: 400, background: 'transparent' }));
  assert.equal(px.channels, 4);
  assert.equal(px.at(5, 5)[3], 0);
});

test('background works with colorScheme dark for dark-canvas renders', async () => {
  // SVG_SCHEMED covers the whole canvas, so the background can only show
  // through the transparent canvas of SVG_TRANSPARENT.
  const px = await pixels(await renderPng(SVG_TRANSPARENT, { max_dimension: 400, colorScheme: 'dark', background: 'rgb(24,24,24)' }));
  assert.deepEqual(px.at(5, 5), [24, 24, 24]);
  assert.deepEqual(px.at(200, 100), [255, 0, 0]);
});

test('background validation: non-string rejected, opaque-canvas conflict rejected', () => {
  const processor = new ImageProcessor();
  assert.throws(() => processor.validateOptions({ background: 24 }), /background must be a non-empty/);
  assert.throws(() => processor.validateOptions({ background: '' }), /background must be a non-empty/);
  assert.throws(() => processor.validateOptions({ background: 'red' }), /background must be a hex/);
  assert.throws(() => processor.validateOptions({ background: '#181818', transparent: false }), /conflict/);
  assert.throws(() => processor.validateOptions({ background: '#181818', svg: { transparent: false } }), /conflict/);
  processor.validateOptions({ background: '#181818' });
  processor.validateOptions({ background: 'rgb(24, 24, 24)' });
  processor.validateOptions({ background: 'rgba(24,24,24,0.5)' });
});

test('SVG is rasterized exactly once per process call', async () => {
  const original = renderer.render.bind(renderer);
  let calls = 0;
  renderer.render = (buffer, options) => {
    calls += 1;
    return original(buffer, options);
  };
  try {
    await renderPng(SVG_400X200, { max_dimension: 400 });
  } finally {
    renderer.render = original;
  }
  assert.equal(calls, 1);
});

test.after(async () => {
  await renderer.shutdown();
});
