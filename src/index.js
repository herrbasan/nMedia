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
import { handleVideo, handleVideoProbe } from './api/routes/video.js';
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
import { handleThumbnail, handleInfo } from './api/routes/media.js';
import { handleUpload } from './api/routes/upload.js';
import { handleProcess } from './api/routes/process.js';
import { handleCapabilities } from './api/routes/capabilities.js';
import {
  handleJobProgress,
  handleGetJob,
  handleCancelJob,
  handleListJobs,
  handleListActiveJobs,
} from './api/routes/jobs.js';
import { WebSocketServer } from './server/WebSocketServer.js';
import { handleWebSocketMessage } from './api/routes/websocket.js';
import { taskManager } from './tasks/TaskManager.js';
import { assetCache } from './cache/AssetCache.js';
import { jobStore } from './jobs/JobStore.js';

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
router.addRoute('POST', '/v1/video/probe', handleVideoProbe);

// New unified process endpoint
router.addRoute('POST', '/v1/process', handleProcess);

// Upload endpoint
router.addRoute('POST', '/v1/upload', handleUpload);

// Job management endpoints
router.addRoute('GET', '/v1/jobs', handleListJobs);
router.addRoute('GET', '/v1/jobs/active', handleListActiveJobs);
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

// Capabilities endpoint
router.addRoute('GET', '/v1/capabilities', handleCapabilities);

// Media utility endpoints
router.addRoute('GET', '/v1/thumbnail/*', handleThumbnail);
router.addRoute('GET', '/v1/info/*', handleInfo);

// Static file serving for Web UI
const publicDir = path.join(__dirname, '../public');
const modulesDir = path.join(__dirname, '../modules');

// Modules access for NUI (must be before catch-all)
router.addRoute('GET', '/modules/*', StaticFileServer.createHandler(modulesDir));

// Web UI - also available under /public/ for compatibility with external dev servers
router.addRoute('GET', '/public/*', StaticFileServer.createHandler(publicDir));

// Web UI - serves from public/ (index.html at root) — catch-all last
router.addRoute('GET', '/*', StaticFileServer.createHandler(publicDir));

// Create HTTP server
const server = createServer((req, res) => {
  HttpServer.handle(req, res, router);
});

// WebSocket server
const wsServer = new WebSocketServer();

wsServer.on('connection', (conn, req) => {
  logger.info('WebSocket connection established', { id: conn.id, url: req.url });

  conn.on('message', (message) => {
    handleWebSocketMessage(conn, message, req);
  });

  conn.on('close', () => {
    logger.info('WebSocket connection closed', { id: conn.id });
  });

  conn.on('error', (err) => {
    logger.error('WebSocket error', { id: conn.id, error: err.message });
  });

  // Send welcome
  conn.send({ type: 'connected', id: conn.id });
});

server.on('upgrade', (req, socket, head) => {
  if (req.url === '/v1/ws') {
    wsServer.handleUpgrade(req, socket, head);
  } else {
    socket.destroy();
  }
});

// Start server
server.listen(config.port, () => {
  logger.info(`nMedia started on port ${config.port}`, {}, 'System', { console: true });
  logger.info(`Max file size: ${config.maxFileSizeMb}MB`, {}, 'System', { console: true });
  logger.info(`Log level: ${config.logLevel}`, {}, 'System', { console: true });
  logger.info(`Web UI available at http://localhost:${config.port}/`, {}, 'System', { console: true });
  logger.info(`WebSocket endpoint: ws://localhost:${config.port}/v1/ws`, {}, 'System', { console: true });
  logger.info(`Capabilities endpoint: http://localhost:${config.port}/v1/capabilities`, {}, 'System', { console: true });
});

export default server;

// Graceful shutdown
let isShuttingDown = false;

async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info(`${signal} received, shutting down gracefully...`, {}, 'System', { console: true });

  // Stop accepting new connections
  server.close(() => {
    logger.info('HTTP server closed', {}, 'System');
  });

  // Close all WebSocket connections
  wsServer.closeAll();

  // Stop task processing
  taskManager.shutdown();

  // Stop cleanup intervals
  assetCache.shutdown();
  jobStore.shutdown();

  logger.info('nMedia shut down', {}, 'System', { console: true });
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));