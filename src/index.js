import { createServer } from 'http';
import config from './config/config.js';
import logger from './utils/logger.js';
import PipelineExecutor from './pipeline/PipelineExecutor.js';
import ProgressReporter from './pipeline/ProgressReporter.js';
import { HttpServer } from './server/HttpServer.js';
import { Router } from './server/Router.js';
import ImageProcessor from './processors/image/ImageProcessor.js';
import AudioProcessor from './processors/audio/AudioProcessor.js';
import VideoProcessor from './processors/video/VideoProcessor.js';
import { handleImage, handleImageCrop, handleHealth } from './api/routes/image.js';
import { handleAudio } from './api/routes/audio.js';
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

// Register processors
PipelineExecutor.register('image', new ImageProcessor());
PipelineExecutor.register('audio', new AudioProcessor());
PipelineExecutor.register('video', new VideoProcessor());

// Create router
const router = new Router();

// Register routes
router.addRoute('GET', '/health', handleHealth);
router.addRoute('POST', '/v1/optimize/image', handleImage);
router.addRoute('POST', '/v1/optimize/image/crop', handleImageCrop);
router.addRoute('POST', '/v1/optimize/audio', handleAudio);
router.addRoute('POST', '/v1/optimize/video', handleVideo);

// Task system routes
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

// Create HTTP server
const server = createServer((req, res) => {
  HttpServer.handle(req, res, router);
});

// Start server
server.listen(config.port, () => {
  logger.info(`Media Service started on port ${config.port}`);
  logger.info(`Max file size: ${config.maxFileSizeMb}MB`);
  logger.info(`Log level: ${config.logLevel}`);
});

export default server;