import test from 'node:test';
import assert from 'node:assert/strict';
import ImageProcessor from '../src/processors/image/ImageProcessor.js';
import AudioProcessor from '../src/processors/audio/AudioProcessor.js';
import VideoProcessor from '../src/processors/video/VideoProcessor.js';
import { pickContractKeys } from '../src/processors/validateOptions.js';

// #8: unknown option keys must fail loud instead of being silently ignored.
// The exact reported repro — forcedColorScheme, dark, background-as-svg-key —
// returned 200 with default processing before the contracts existed.

test('image: unknown option keys are rejected', () => {
  const processor = new ImageProcessor();
  const cases = [
    { forcedColorScheme: 'dark' },
    { dark: true },
    { quaility: 90 },
    { crop: { type: 'region', left: 0, top: 0, right: 1, bottom: 1 }, resample: true },
  ];
  for (const options of cases) {
    assert.throws(() => processor.validateOptions(options), /Unknown image option/, JSON.stringify(options));
  }
});

test('image: known keys and internal _-prefixed keys pass', () => {
  const processor = new ImageProcessor();
  processor.validateOptions({
    max_dimension: 800, quality: 80, format: 'png', strip_exif: true,
    rotate: 90, flip: true, flop: true, grayscale: true, normalize: true, blur: 1,
    density: 2, width: 100, height: 50, colorScheme: 'dark', color_scheme: 'light',
    transparent: true, background: '#181818',
    svg: { density: 1, width: 10, height: 10, colorScheme: 'dark', transparent: true },
    _inputSource: 'buffer',
  });
});

test('image: unknown keys inside options.svg are rejected', () => {
  const processor = new ImageProcessor();
  assert.throws(() => processor.validateOptions({ svg: { forcedColorScheme: 'dark' } }), /Unknown svg option/);
  assert.throws(() => processor.validateOptions({ svg: { density: 2, background: '#fff' } }), /Unknown svg option/);
});

test('image: non-object options are rejected', () => {
  const processor = new ImageProcessor();
  assert.throws(() => processor.validateOptions(['format']), /must be an object/);
});

test('audio: unknown option keys are rejected, known keys pass', () => {
  const processor = new AudioProcessor();
  assert.throws(() => processor.validateOptions({ bitrate: 128 }), /Unknown audio option/);
  assert.throws(() => processor.validateOptions({ sampleRate: 16000 }), /Unknown audio option/);
  processor.validateOptions({ sample_rate: 16000, channels: 1, format: 'mp3', audio_bitrate: 128000, _inputSource: 'path' });
});

test('video: unknown option keys are rejected, known keys pass', () => {
  const processor = new VideoProcessor();
  // response_type/output_format/width/crf/preset were forwarded by the legacy
  // route and silently ignored; the contract now rejects them.
  assert.throws(() => processor.validateOptions({ response_type: 'file' }), /Unknown video option/);
  assert.throws(() => processor.validateOptions({ output_format: 'mp4' }), /Unknown video option/);
  assert.throws(() => processor.validateOptions({ crf: 23 }), /Unknown video option/);
  processor.validateOptions({
    mode: 'transcode', fps: 10, format: 'mp3', max_dimension: 720,
    video_codec: 'libx264', audio_codec: 'aac', hwaccel: 'none',
    cli_command: '-c:v libx264', audio_bitrate: 128000, _inputSource: 'buffer',
  });
});

test('pickContractKeys keeps only processor contract keys', () => {
  const picked = pickContractKeys('video', {
    mode: 'transcode', response_type: 'file', output_format: 'mp4',
    width: 1280, crf: 23, preset: 'fast', fps: 2, _inputSource: 'buffer',
  });
  assert.deepEqual(picked, { mode: 'transcode', fps: 2 });
  assert.deepEqual(pickContractKeys('video', 'nope'), {});
  assert.deepEqual(pickContractKeys('video', undefined), {});
});
