import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const configPath = path.join(__dirname, '../../config.json');

if (!fs.existsSync(configPath)) {
  throw new Error(`Configuration file not found: ${configPath}`);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

if (!config.server?.port) {
  throw new Error('server.port is required in config.json');
}

if (!config.logging?.logsDir) {
  throw new Error('logging.logsDir is required in config.json');
}

if (!config.media?.gpu?.platform) {
  throw new Error('media.gpu.platform is required in config.json (e.g., "nvenc", "vaapi", "cpu")');
}

export default {
  port: config.server.port,
  host: config.server.host,
  maxFileSizeMb: config.media.maxFileSizeMb,
  maxFileSizeBytes: config.media.maxFileSizeMb * 1024 * 1024,
  gpuPlatform: config.media.gpu.platform,
  gpuDevice: config.media.gpu.device ?? 0,
  gpuMaxConcurrentSessions: config.media.gpu.maxConcurrentSessions ?? 4,
  logLevel: config.logging.level,
  logsDir: path.resolve(process.cwd(), config.logging.logsDir),
  sessionPrefix: config.logging.sessionPrefix,
  logRetentionDays: config.logging.retentionDays,
  cacheDir: path.resolve(process.cwd(), config.cache.dir),
  cacheTtl: config.cache.ttl,
  cacheMaxSize: config.cache.maxSize,
  maxConcurrentTasks: config.workers.maxConcurrentTasks,
  workersMode: config.workers.mode ?? 'queue',
  messageTransport: config.messaging.transport,
  allowedInputPaths: (config.media.allowedInputPaths || []).map(p => p === '*' ? '*' : path.resolve(p)),
  allowedOutputPaths: (config.media.allowedOutputPaths || []).map(p => p === '*' ? '*' : path.resolve(p)),
  allowUncPaths: config.media.allowUncPaths ?? false,
  maxConcurrentUploads: config.server.maxConcurrentUploads ?? 4,
};
