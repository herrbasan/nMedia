import logger, { logError } from '../utils/logger.js';

/**
 * FIFO task queue with concurrency control.
 */
export class TaskQueue {
  /**
   * @param {number} maxConcurrent - Maximum concurrent tasks
   */
  constructor(maxConcurrent = 4) {
    this.maxConcurrent = maxConcurrent;
    /** @type {import('./Task.js').Task[]} */
    this.queue = [];
    /** @type {Set<string>} */
    this.running = new Set();
    /** @type {Function|null} */
    this.processor = null;
  }

  /**
   * Set the processor function to call when tasks are dequeued
   * @param {Function} fn - async function(task) that processes the task
   */
  setProcessor(fn) {
    this.processor = fn;
  }

  /**
   * Enqueue a task. Resolves on acceptance, not on start: POST /v1/process
   * returns the job id immediately, and the job record carries its own queue
   * position. Waiting for a worker slot made submissions block for seconds
   * under a burst.
   * @param {import('./Task.js').Task} task
   * @returns {Promise<void>}
   */
  async enqueue(task) {
    if (this.running.size < this.maxConcurrent) {
      this._startTask(task);
      return;
    }
    this.queue.push(task);
    logger.info('Task queued', { taskId: task.id, queueLength: this.queue.length, maxConcurrent: this.maxConcurrent, running: this.running.size });
  }

  /**
   * Cancel a pending task
   * @param {string} taskId
   * @returns {boolean}
   */
  cancel(taskId) {
    // Check if in queue
    const queueIndex = this.queue.findIndex((t) => t.id === taskId);
    if (queueIndex !== -1) {
      const task = this.queue.splice(queueIndex, 1)[0];
      task.cancel();
      return true;
    }
    return false;
  }

  /**
   * Get number of queued tasks
   * @returns {number}
   */
  getQueueLength() {
    return this.queue.length;
  }

  /**
   * Get number of running tasks
   * @returns {number}
   */
  getRunningCount() {
    return this.running.size;
  }

  /**
   * Check if queue is empty
   * @returns {boolean}
   */
  isEmpty() {
    return this.queue.length === 0 && this.running.size === 0;
  }

  /**
   * Start a task (internal)
   * @param {import('./Task.js').Task} task
   * @private
   */
  _startTask(task) {
    this.running.add(task.id);

    // Cleanup after task completes. Idempotent: the queue also calls it when
    // the processor rejects before a worker could settle the task.
    const cleanup = () => {
      if (!this.running.delete(task.id)) return;
      this._processNext();
    };

    // The worker calls this from its finally block, after activeTask is cleared.
    // Calling it earlier (from the completion path) let a dispatch look for an
    // idle worker while the finishing worker was still marked busy.
    task._onSettled = cleanup;

    logger.info('Task dequeued', { taskId: task.id, running: this.running.size, queueRemaining: this.queue.length });

    // Call the processor if set (fire and forget, errors handled in processor)
    if (this.processor) {
      this.processor(task).catch((err) => {
        logError('Processor error', err, {
          taskId: task.id,
          type: task.type,
          running: this.running.size,
          queueRemaining: this.queue.length,
        });
        task.fail(err);
        cleanup();
      });
    }
  }

  /**
   * Process next task in queue (internal)
   * @private
   */
  _processNext() {
    if (this.queue.length > 0 && this.running.size < this.maxConcurrent) {
      this._startTask(this.queue.shift());
    }
  }

  /**
   * Clear the queue
   * @returns {number} - Number of tasks cleared
   */
  clear() {
    const cleared = this.queue.length;
    for (const task of this.queue) {
      task.cancel();
    }
    this.queue = [];
    return cleared;
  }
}
