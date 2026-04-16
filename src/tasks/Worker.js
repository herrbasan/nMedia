import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Worker } from 'worker_threads';
import PipelineExecutor from '../pipeline/PipelineExecutor.js';
import { assetCache } from '../cache/AssetCache.js';
import { jobStore, JobStatus } from '../jobs/JobStore.js';
import logger from '../utils/logger.js';
import config from '../config/config.js';

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

    const jobId = task._jobId;
    if (jobId) {
      jobStore.updateJob(jobId, JobStatus.PROCESSING, { message: 'Processing' });
    }

    try {
      task.start();

      let result;
      const inputSource = await this._resolveInput(task);

      if (this.mode === 'thread') {
        result = await this._processInThread(task, inputSource);
      } else {
        result = await this._processInQueue(task, inputSource);
      }

      task.complete(result);

      // Store result in asset cache
      if (result?.buffer) {
        const mimeType = result.metadata?.mimeType || this._getMimeType(task.type);
        const asset = assetCache.store(task.type, result.buffer, mimeType, result.metadata);
        task.setAssetId(asset.id);

        if (jobId) {
          jobStore.updateJob(jobId, JobStatus.COMPLETED, {
            assetId: asset.id,
            message: 'Complete',
            percent: 100,
          });
        }

        logger.debug('Task result cached', { taskId: task.id, assetId: asset.id });
      }

      task._onDone?.(result);

      logger.info('Task completed', {
        taskId: task.id,
        type: task.type,
        mode: this.mode,
        duration: task.getDuration(),
      });
    } catch (error) {
      task.fail(error.message);

      if (jobId) {
        jobStore.updateJob(jobId, JobStatus.FAILED, {
          error: error.message,
          message: 'Failed',
        });
      }

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
   * Resolve input source for the task.
   * Returns the actual buffer or file path to process.
   */
  async _resolveInput(task) {
    const input = task.input;

    // Pattern A: input_path
    if (typeof input === 'string' && !input.startsWith('upload-') && fs.existsSync(input)) {
      return { type: 'path', value: input };
    }

    // Pattern B: fileId
    if (typeof input === 'string' && input.startsWith('upload-')) {
      const upload = jobStore.getUpload(input);
      if (!upload) {
        throw new Error(`Upload not found or expired: ${input}`);
      }
      return { type: 'path', value: upload.tempPath };
    }

    // Legacy: buffer input
    if (Buffer.isBuffer(input)) {
      return { type: 'buffer', value: input };
    }

    throw new Error('Invalid input: must be input_path, fileId, or buffer');
  }

  /**
   * Process task on main thread via PipelineExecutor (queue mode)
   */
  async _processInQueue(task, inputSource) {
    const input = inputSource.type === 'buffer' ? inputSource.value : inputSource.value;
    const options = { ...task.options, _inputSource: inputSource.type };

    return await PipelineExecutor.execute(
      task.type,
      input,
      options,
      task.progressReporter,
      task.id
    );
  }

  /**
   * Process task in worker_thread (thread mode)
   */
  async _processInThread(task, inputSource) {
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
        inputSource: inputSource,
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
