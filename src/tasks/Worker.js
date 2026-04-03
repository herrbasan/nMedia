import PipelineExecutor from '../pipeline/PipelineExecutor.js';
import logger from '../utils/logger.js';
import { assetCache } from '../cache/AssetCache.js';

/**
 * Worker that processes tasks from the queue.
 */
export class Worker {
  /**
   * @param {string} id - Worker ID
   * @param {import('./TaskQueue.js').TaskQueue} queue - Task queue
   * @param {import('./TaskStore.js').TaskStore} store - Task store
   */
  constructor(id, queue, store) {
    this.id = id;
    this.queue = queue;
    this.store = store;
    this.activeTask = null;
  }

  /**
   * Process a task
   * @param {import('./Task.js').Task} task
   */
  async process(task) {
    this.activeTask = task;

    try {
      task.start();

      // Create progress callback that wraps task's updateProgress
      const onProgress = (percent, message) => {
        task.updateProgress(percent, message);
      };

      // Execute the processor
      const result = await PipelineExecutor.execute(
        task.type,
        task.input,
        task.options,
        task.progressReporter,
        task.id
      );

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
        duration: task.getDuration(),
      });
    } catch (error) {
      task.fail(error.message);

      // Call the queue's onError handler
      task._onError?.(error);

      logger.error('Task failed', {
        taskId: task.id,
        type: task.type,
        error: error.message,
      });
    } finally {
      this.activeTask = null;
    }
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
