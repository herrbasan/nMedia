import test from 'node:test';
import assert from 'node:assert/strict';
import { runProcessorHealthCheck, getProcessorHealth } from '../src/processors/health.js';
import { renderer } from '../modules/nImage/lib/svg-renderer.js';

test('startup self-check reports every backend', async () => {
  const health = await runProcessorHealthCheck();

  assert.equal(getProcessorHealth(), health);
  assert.equal(typeof health.checkedAt, 'string');

  // sharp is a hard requirement of nImage, so it must pass here.
  assert.equal(health.image.backends.sharp.ok, true);

  // ImageMagick and the SVG browser are environment-dependent: each must
  // report a boolean plus an error string when it fails.
  for (const backend of ['imagemagick', 'svg']) {
    const status = health.image.backends[backend];
    assert.equal(typeof status.ok, 'boolean');
    if (!status.ok) assert.equal(typeof status.error, 'string');
  }

  assert.equal(typeof health.audio.backends.nvideo.ok, 'boolean');
  assert.equal(health.audio.ok, health.audio.backends.nvideo.ok);
  assert.equal(health.video.ok, health.audio.backends.nvideo.ok);
});

test.after(async () => {
  await renderer.shutdown();
});
