import { createLogger, getLogger } from '../../modules/nLogger/src/logger.js';
import config from '../config/config.js';

createLogger({
  logsDir: config.logsDir,
  sessionPrefix: config.sessionPrefix,
  retentionDays: config.logRetentionDays,
});

const logger = getLogger();

// nLogger's constructor ignores options.level; the level is set on the instance.
logger.setLevel(config.logLevel);

/**
 * Log a failure with its Error object.
 *
 * nLogger's signature is error(message, error, meta, type) — passing a meta
 * object as the second argument silently drops every field (and promotes a
 * `message` field from that object into the error slot).
 *
 * nLogger also truncates metadata strings longer than 500 characters, which
 * would reduce a stack trace to its message and one frame. Arrays are sanitized
 * element by element, so the stack is passed as an array of lines.
 */
export function logError(message, error, meta = {}) {
  if (error instanceof Error) {
    logger.error(message, error, { ...meta, stack: error.stack.split('\n') });
    return;
  }
  if (error === undefined || error === null) {
    logger.error(message, null, meta);
    return;
  }
  logger.error(message, null, { ...meta, error: String(error) });
}

export default logger;
