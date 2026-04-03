import logger from '../utils/logger.js';

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
    /** @type {Map<string, Function>} */
    this.waiters = new Map();
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
   * Enqueue a task
   * @param {import('./Task.js').Task} task
   * @returns {Promise<void>}
   */
  async enqueue(task) {
    return new Promise((resolve, reject) => {
      // Check if we can run immediately
      if (this.running.size < this.maxConcurrent) {
        this._startTask(task, resolve, reject);
      } else {
        // Add to queue
        this.queue.push(task);
        // Store resolver for when task starts
        this.waiters.set(task.id, { resolve, reject });
        logger.debug('Task queued', { taskId: task.id, queueLength: this.queue.length });
      }
    });
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
      // Reject the pending promise
      const waiter = this.waiters.get(taskId);
      if (waiter) {
        waiter.reject(new Error('Task cancelled'));
        this.waiters.delete(taskId);
      }
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
   * @param {Function} resolve - Resolves immediately when task starts processing
   * @param {Function} reject
   * @private
   */
  _startTask(task, resolve, reject) {
    this.running.add(task.id);

    // Resolve immediately so caller knows task has started
    resolve();

    // Cleanup after task completes
    const cleanup = () => {
      this.running.delete(task.id);
      this._processNext();
    };

    // Store callbacks on task
    task._onDone = cleanup;
    task._onError = cleanup;

    logger.debug('Task dequeued', { taskId: task.id, running: this.running.size });

    // Call the processor if set (fire and forget, errors handled in processor)
    if (this.processor) {
      this.processor(task).catch((err) => {
        logger.error('Processor error', { taskId: task.id, error: err.message });
        task.fail(err.message);
      });
    }
  }

  /**
   * Process next task in queue (internal)
   * @private
   */
  _processNext() {
    if (this.queue.length > 0 && this.running.size < this.maxConcurrent) {
      const next = this.queue.shift();
      const waiter = this.waiters.get(next.id);

      if (waiter) {
        this.waiters.delete(next.id);
        this._startTask(next, waiter.resolve, waiter.reject);
      }
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
      const waiter = this.waiters.get(task.id);
      if (waiter) {
        waiter.reject(new Error('Queue cleared'));
        this.waiters.delete(task.id);
      }
    }
    this.queue = [];
    return cleared;
  }
}
