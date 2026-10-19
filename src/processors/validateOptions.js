/**
 * Processor option contracts — the single source of truth for accepted
 * option keys. Unknown keys are rejected instead of silently ignored, so a
 * typo fails loud (400 at request time, error at execute time) rather than
 * returning a default-processed asset that looks like success (#8).
 *
 * Keys prefixed with `_` are internal plumbing injected by the task layer
 * (e.g. `_inputSource`) and always pass.
 */

const IMAGE_OPTION_KEYS = new Set([
  'max_dimension', 'quality', 'format', 'strip_exif', 'crop',
  'rotate', 'flip', 'flop', 'grayscale', 'normalize', 'blur',
  'density', 'width', 'height', 'colorScheme', 'color_scheme',
  'transparent', 'svg', 'background',
]);

const SVG_SHAPE_KEYS = new Set([
  'density', 'width', 'height', 'colorScheme', 'color_scheme', 'transparent',
]);

const AUDIO_OPTION_KEYS = new Set([
  'sample_rate', 'channels', 'format', 'audio_bitrate',
]);

const VIDEO_OPTION_KEYS = new Set([
  'mode', 'fps', 'format', 'max_dimension', 'video_codec',
  'audio_codec', 'hwaccel', 'cli_command', 'audio_bitrate',
]);

const CONTRACTS = {
  image: IMAGE_OPTION_KEYS,
  audio: AUDIO_OPTION_KEYS,
  video: VIDEO_OPTION_KEYS,
};

function rejectUnknown(label, allowed, options) {
  if (options === undefined || options === null) return;
  if (typeof options !== 'object' || Array.isArray(options)) {
    throw new Error(`${label} must be an object`);
  }
  const unknown = Object.keys(options).filter((key) => !key.startsWith('_') && !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`Unknown ${label} option(s): ${unknown.join(', ')}. Allowed: ${[...allowed].join(', ')}`);
  }
}

export function rejectUnknownImageOptions(options) {
  rejectUnknown('image', IMAGE_OPTION_KEYS, options);
}

export function rejectUnknownAudioOptions(options) {
  rejectUnknown('audio', AUDIO_OPTION_KEYS, options);
}

export function rejectUnknownVideoOptions(options) {
  rejectUnknown('video', VIDEO_OPTION_KEYS, options);
}

export function rejectUnknownSvgShapeKeys(shape) {
  rejectUnknown('svg', SVG_SHAPE_KEYS, shape);
}

/**
 * Reduce a route-built option object to the processor's contract keys.
 * Legacy routes assemble their objects from free-form body fields and used to
 * forward everything; execute-time validation now rejects non-contract keys,
 * so routes hand the executor only what the processor accepts.
 */
export function pickContractKeys(processor, options) {
  const allowed = CONTRACTS[processor];
  const picked = {};
  if (options !== undefined && options !== null && typeof options === 'object' && !Array.isArray(options)) {
    for (const key of Object.keys(options)) {
      if (allowed.has(key)) picked[key] = options[key];
    }
  }
  return picked;
}
