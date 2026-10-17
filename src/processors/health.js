import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createRequire } from 'module';
import logger, { logError } from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const require = createRequire(import.meta.url);
const nVideo = require(path.join(__dirname, '../../modules/nVideo/lib/index.js'));
const nImage = (await import(pathToFileURL(path.join(__dirname, '../../modules/nImage/lib/index.js')).href)).default;

let health = null;

/**
 * Verify the processor backends once, at startup. Never throws; the result is
 * cached and served by /health and /v1/capabilities.
 */
export async function runProcessorHealthCheck() {
  const image = await nImage.selfCheck();

  let nvideo;
  try {
    // Only the version belongs in a health response; the full build info
    // (dozens of codec flags and protocols) is served by /v1/capabilities.
    nvideo = { ok: true, version: nVideo.getBuildInfo().version };
  } catch (error) {
    nvideo = { ok: false, error: error.message };
  }

  health = {
    checkedAt: new Date().toISOString(),
    image: {
      ok: image.sharp.ok,
      reason: image.sharp.ok ? null : `sharp unavailable: ${image.sharp.error}`,
      backends: image,
    },
    audio: {
      ok: nvideo.ok,
      reason: nvideo.ok ? null : `nVideo unavailable: ${nvideo.error}`,
      backends: { nvideo },
    },
    video: {
      ok: nvideo.ok,
      reason: nvideo.ok ? null : `nVideo unavailable: ${nvideo.error}`,
      backends: { nvideo },
    },
  };

  return health;
}

export function getProcessorHealth() {
  return health;
}

/**
 * One startup line per processor, plus an error for every unavailable backend.
 */
export function logProcessorHealth() {
  for (const name of ['image', 'audio', 'video']) {
    const processor = health[name];
    if (processor.ok) {
      logger.info(`Processor ready: ${name}`, { processor: name }, 'System', { console: true });
    } else {
      logError(`Processor unavailable: ${name}`, new Error(processor.reason), { processor: name });
    }
  }

  for (const [backend, status] of Object.entries(health.image.backends)) {
    if (!status.ok) {
      logError(`Image backend unavailable: ${backend}`, new Error(status.error), { backend });
    }
  }
}
