import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Worker } from 'worker_threads';
import { fork } from 'child_process';
import PipelineExecutor from '../pipeline/PipelineExecutor.js';
import { assetCache } from '../cache/AssetCache.js';
import { jobStore, JobStatus } from '../jobs/JobStore.js';
import logger from '../utils/logger.js';
import config from '../config/config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Worker that processes tasks from the queue.
 * Supports three modes:
 * - queue: Runs on main thread via PipelineExecutor
 * - thread: Spawns a worker_thread for parallelism
 * - process: Spawns a child_process.fork for max isolation against native crashes
 */
export class TaskWorker {
  /**
   * @param {string} id - Worker ID
   * @param {import('./TaskQueue.js').TaskQueue} queue - Task queue
   * @param {import('./TaskStore.js').TaskStore} store - Task store
   * @param {string} mode - 'queue', 'thread', or 'process'
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
    logger.info('Worker processing task', { workerId: this.id, taskId: task.id, jobId, type: task.type, mode: task.options?.mode, workerMode: this.mode });

    if (jobId) {
      jobStore.updateJob(jobId, JobStatus.PROCESSING, { message: 'Processing' });
    }

    try {
      task.start();

      let result;
      const inputSource = await this._resolveInput(task);
      logger.info('Worker input resolved', { taskId: task.id, inputType: inputSource.type, inputValue: typeof inputSource.value === 'string' ? inputSource.value : '<buffer>' });

      if (this.mode === 'thread') {
        logger.info('Worker spawning thread', { taskId: task.id });
        result = await this._processInThread(task, inputSource);
        } else if (this.mode === 'process') {
          logger.info('Worker spawning child process', { taskId: task.id });
          result = await this._processInChildProcess(task, inputSource);
      }

      // Store result in asset cache
        if (result?.buffer || result?.filePath) {
          const mimeType = result.metadata?.mimeType || this._getMimeType(task.type);
          let asset;
          
          if (result.filePath) {
            logger.info('Worker caching result from file', { taskId: task.id, filePath: result.filePath, mimeType });
            asset = assetCache.storeFile(task.type, result.filePath, mimeType, result.metadata);
            try { fs.unlinkSync(result.filePath); } catch {} // Cleanup temp file after renaming/copying
          } else {
            logger.info('Worker caching result', { taskId: task.id, bufferSize: result.buffer.length, mimeType });
            asset = assetCache.store(task.type, result.buffer, mimeType, result.metadata);
          }

        logger.info('Worker result cached', { taskId: task.id, assetId: asset.id });

        // Cache extra buffers (multi-crop results)
        if (result.extraBuffers && result.extraBuffers.length > 0) {
          const cropAssets = [asset.id];
          for (const extraBuf of result.extraBuffers) {
            const extraAsset = assetCache.store(task.type, extraBuf, mimeType, { ...result.metadata, outputSize: extraBuf.length });
            cropAssets.push(extraAsset.id);
          }
          result.metadata.cropAssetIds = cropAssets;
          logger.info('Worker crop results cached', { taskId: task.id, cropCount: cropAssets.length, assetIds: cropAssets });
        }

        if (jobId) {
          jobStore.updateJob(jobId, JobStatus.COMPLETED, {
            assetId: asset.id,
            message: 'Complete',
            percent: 100,
            metadata: result.metadata,
          });
        }

        // Write to output path if specified
        if (task.outputPath) {
          let outputPath = task.outputPath;
          // If path is a directory, auto-generate filename
          try {
            const stat = fs.statSync(outputPath);
            if (stat.isDirectory()) {
              const ext = { image: 'jpg', audio: 'mp3', video: 'mp4' }[task.type] || 'bin';
              outputPath = path.join(outputPath, `output-${Date.now()}.${ext}`);
            }
          } catch {
            // path doesn't exist yet, check if it looks like a directory (no extension)
            if (!path.extname(outputPath)) {
              const ext = { image: 'jpg', audio: 'mp3', video: 'mp4' }[task.type] || 'bin';
              outputPath = path.join(outputPath, `output-${Date.now()}.${ext}`);
            }
          }
          fs.mkdirSync(path.dirname(outputPath), { recursive: true });
          fs.writeFileSync(outputPath, result.buffer);
          logger.info('Task result written to output path', { taskId: task.id, outputPath });
        }

        task.complete(result, asset.id);
      } else {
        logger.info('Worker completing without buffer', { taskId: task.id, hasResult: !!result });
        task.complete(result);
      }

      task._onDone?.(result);

      logger.info('Task completed', {
        taskId: task.id,
        type: task.type,
        workerMode: this.mode,
        duration: task.getDuration(),
        assetId: task.assetId,
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
          task.updateProgress(message.percent, message.message || String(message.metadata || ''));
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
   * Process task in child_process.fork (process mode) for maximum isolation
   */
  async _processInChildProcess(task, inputSource) {
    return new Promise((resolve, reject) => {
      const taskWorkerPath = path.join(__dirname, 'TaskWorker.js');

      this.nativeWorker = fork(taskWorkerPath, [], {
        env: { ...process.env, WORKER_MODE: 'process', TASK_ID: task.id },
        serialization: 'advanced' // allow Buffer optimization
      });

      this.nativeWorker.on('message', (message) => {
        if (message.type === 'progress') {
          task.updateProgress(message.percent, message.message || String(message.metadata || ''));
        } else if (message.type === 'complete') {
          resolve(message.result);
        } else if (message.type === 'error') {
          reject(new Error(message.message));
        }
      });

      this.nativeWorker.on('error', (err) => {
        reject(err);
      });

      this.nativeWorker.on('exit', (code, signal) => {
        if (code !== 0) {
          const detail = signal ? `signal ${signal}` : `exit code ${code}`;
          reject(new Error(`Native execution crashed or stopped with ${detail}`));
        }
      });

      this.nativeWorker.send({
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
