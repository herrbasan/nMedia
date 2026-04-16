import { createServer } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import config from './config/config.js';
import logger from './utils/logger.js';
import PipelineExecutor from './pipeline/PipelineExecutor.js';
import ProgressReporter from './pipeline/ProgressReporter.js';
import { HttpServer } from './server/HttpServer.js';
import { Router } from './server/Router.js';
import { StaticFileServer } from './server/StaticFileServer.js';
import ImageProcessor from './processors/image/ImageProcessor.js';
import AudioProcessor from './processors/audio/AudioProcessor.js';
import VideoProcessor from './processors/video/VideoProcessor.js';
import { handleImage, handleImageCrop, handleHealth } from './api/routes/image.js';
import { handleAudio, handleAudioProbe } from './api/routes/audio.js';
import { handleVideo } from './api/routes/video.js';
import {
  handleCreateTask,
  handleListTasks,
  handleGetTask,
  handleGetTaskResult,
  handleCancelTask,
  handleTaskStats,
} from './api/routes/tasks.js';
import {
  handleGetAsset,
  handleGetAssetMetadata,
  handleDeleteAsset,
  handleClearAssets,
  handleListAssets,
} from './api/routes/assets.js';
import { handleUpload } from './api/routes/upload.js';
import { handleProcess } from './api/routes/process.js';
import {
  handleJobProgress,
  handleGetJob,
  handleCancelJob,
  handleListJobs,
} from './api/routes/jobs.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Register processors
PipelineExecutor.register('image', new ImageProcessor());
PipelineExecutor.register('audio', new AudioProcessor());
PipelineExecutor.register('video', new VideoProcessor());

// Create router
const router = new Router();

// Register routes
router.addRoute('GET', '/health', handleHealth);

// Legacy routes (still supported during migration)
router.addRoute('POST', '/v1/process/image', handleImage);
router.addRoute('POST', '/v1/process/image/crop', handleImageCrop);
router.addRoute('POST', '/v1/process/audio', handleAudio);
router.addRoute('POST', '/v1/audio/probe', handleAudioProbe);
router.addRoute('POST', '/v1/process/video', handleVideo);

// New unified process endpoint
router.addRoute('POST', '/v1/process', handleProcess);

// Upload endpoint
router.addRoute('POST', '/v1/upload', handleUpload);

// Job management endpoints
router.addRoute('GET', '/v1/jobs', handleListJobs);
router.addRoute('GET', '/v1/jobs/:jobId', handleGetJob);
router.addRoute('GET', '/v1/jobs/:jobId/progress', handleJobProgress);
router.addRoute('DELETE', '/v1/jobs/:jobId', handleCancelJob);

// Task system routes (legacy)
router.addRoute('POST', '/v1/tasks', handleCreateTask);
router.addRoute('GET', '/v1/tasks', handleListTasks);
router.addRoute('GET', '/v1/tasks/stats', handleTaskStats);
router.addRoute('GET', '/v1/tasks/:taskId', handleGetTask);
router.addRoute('GET', '/v1/tasks/:taskId/result', handleGetTaskResult);
router.addRoute('DELETE', '/v1/tasks/:taskId', handleCancelTask);

// Asset cache routes
router.addRoute('GET', '/v1/assets', handleListAssets);
router.addRoute('GET', '/v1/assets/:id', handleGetAsset);
router.addRoute('GET', '/v1/assets/:id/metadata', handleGetAssetMetadata);
router.addRoute('DELETE', '/v1/assets/:id', handleDeleteAsset);
router.addRoute('DELETE', '/v1/assets', handleClearAssets);

// Static file serving for Admin UI
const publicDir = path.join(__dirname, '../public');
const modulesDir = path.join(__dirname, '../modules');

// Admin UI - serves from public/admin
router.addRoute('GET', '/admin/*', StaticFileServer.createHandler(path.join(publicDir, 'admin')));

// Redirect /admin to /admin/ (for relative paths to work)
router.addRoute('GET', '/admin', (ctx) => {
  ctx.rawResponse.writeHead(302, { 'Location': '/admin/' });
  ctx.rawResponse.end();
});

// Modules access for NUI (so NUI files can be loaded from modules/nui_wc2)
router.addRoute('GET', '/modules/*', StaticFileServer.createHandler(modulesDir));

// Create HTTP server
const server = createServer((req, res) => {
  HttpServer.handle(req, res, router);
});

// Start server
server.listen(config.port, () => {
  logger.info(`Media Service started on port ${config.port}`);
  logger.info(`Max file size: ${config.maxFileSizeMb}MB`);
  logger.info(`Log level: ${config.logLevel}`);
  logger.info(`Admin UI available at http://localhost:${config.port}/admin/`);
});

export default server;