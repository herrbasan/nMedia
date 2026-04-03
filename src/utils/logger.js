import { createLogger, getLogger } from '../../modules/nLogger/src/logger.js';
import config from '../config/config.js';

createLogger({
  logsDir: config.logsDir,
  sessionPrefix: config.sessionPrefix,
  retentionDays: config.logRetentionDays,
  level: config.logLevel,
});

const logger = getLogger();

export default logger;
