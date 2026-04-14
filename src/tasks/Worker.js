import path from 'path';
import { fileURLToPath } from 'url';
import { Worker } from 'worker_threads';
import PipelineExecutor from '../pipeline/PipelineExecutor.js';
import logger from '../utils/logger.js';
import config from '../config/config.js';
import { assetCache } from '../cache/AssetCache.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Worker that processes tasks from the queue.
 * Supports two modes:
 * - queue: Runs on main thread via PipelineExecutor
 * - thread: Spawns a worker_thread for true parallelism
 */
export class TaskWorker {
  /**
   * @param {string} id - Worker ID
   * @param {import('./TaskQueue.js').TaskQueue} queue - Task queue
   * @param {import('./TaskStore.js').TaskStore} store - Task store
   * @param {string} mode - 'queue' or 'thread'
   */
  constructor(id, queue, store, mode = 'queue') {
    this.id = id;
    this.queue = queue;
    this.store = store;
    this.mode = mode;
    this.activeTask = null;
    this.nativeWorker = null;
  }

  /**
   * Process a task
   * @param {import('./Task.js').Task} task
   */
  async process(task) {
    this.activeTask = task;

    try {
      task.start();

      let result;
      if (this.mode === 'thread') {
        result = await this._processInThread(task);
      } else {
        result = await this._processInQueue(task);
      }

      task.complete(result);

      // Store result in asset cache if it has a buffer
      if (result?.buffer) {
        const mimeType = result.metadata?.mimeType || this._getMimeType(task.type);
        const asset = assetCache.store(task.type, result.buffer, mimeType, result.metadata);
        task.setAssetId(asset.id);
        logger.debug('Task result cached', { taskId: task.id, assetId: asset.id });
      }

      // Call the queue's onDone handler
      task._onDone?.(result);

      logger.info('Task completed', {
        taskId: task.id,
        type: task.type,
        mode: this.mode,
        duration: task.getDuration(),
      });
    } catch (error) {
      task.fail(error.message);

      // Call the queue's onError handler
      task._onError?.(error);

      logger.error('Task failed', {
        taskId: task.id,
        type: task.type,
        mode: this.mode,
        error: error.message,
      });
    } finally {
      this.activeTask = null;
      if (this.nativeWorker) {
        this.nativeWorker.terminate();
        this.nativeWorker = null;
      }
    }
  }

  /**
   * Process task on main thread via PipelineExecutor (queue mode)
   */
  async _processInQueue(task) {
    return await PipelineExecutor.execute(
      task.type,
      task.input,
      task.options,
      task.progressReporter,
      task.id
    );
  }

  /**
   * Process task in worker_thread (thread mode)
   */
  async _processInThread(task) {
    return new Promise((resolve, reject) => {
      const taskWorkerPath = path.join(__dirname, 'TaskWorker.js');

      this.nativeWorker = new Worker(taskWorkerPath, {
        workerData: { taskId: task.id },
      });

      this.nativeWorker.on('message', (message) => {
        if (message.type === 'progress') {
          task.updateProgress(message.percent, message.metadata);
        } else if (message.type === 'complete') {
          resolve(message.result);
        } else if (message.type === 'error') {
          reject(new Error(message.message));
        }
      });

      this.nativeWorker.on('error', (err) => {
        reject(err);
      });

      this.nativeWorker.on('exit', (code) => {
        if (code !== 0) {
          reject(new Error(`Worker stopped with exit code ${code}`));
        }
      });

      // Send task to worker
      this.nativeWorker.postMessage({
        type: 'process',
        mediaType: task.type,
        inputBuffer: task.input,
        options: task.options,
        cacheDir: config.cacheDir,
      });
    });
  }

  /**
   * Get default MIME type for task type
   * @param {string} type
   * @returns {string}
   */
  _getMimeType(type) {
    const mimeTypes = {
      image: 'image/jpeg',
      audio: 'audio/mpeg',
      video: 'video/mp4',
    };
    return mimeTypes[type] || 'application/octet-stream';
  }
}
