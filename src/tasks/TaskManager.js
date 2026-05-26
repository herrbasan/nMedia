import { v4 as uuidv4 } from '../utils/uuid.js';
import { Task, TaskStatus } from './Task.js';
import { TaskStore } from './TaskStore.js';
import { TaskQueue } from './TaskQueue.js';
import { TaskWorker } from './Worker.js';
import ProgressReporter from '../pipeline/ProgressReporter.js';
import logger from '../utils/logger.js';
import config from '../config/config.js';

/**
 * TaskManager coordinates task creation, queuing, and execution.
 * Singleton that manages the task lifecycle.
 */
class TaskManager {
  constructor() {
    this.store = new TaskStore();
    this.queue = new TaskQueue(config.maxConcurrentTasks);
    this.workers = [];
    this.cleanupInterval = null;

    // Create workers based on maxConcurrentTasks
    this._createWorkers();

    // Wire up queue processor
    this.queue.setProcessor(async (task) => {
      await this.startTask(task);
    });

    // Start cleanup interval
    this._startCleanup();
  }

  /**
   * Create worker pool
   * @private
   */
  _createWorkers() {
    const mode = config.workersMode || 'queue';
    for (let i = 0; i < config.maxConcurrentTasks; i++) {
      this.workers.push(new TaskWorker(`worker-${i}`, this.queue, this.store, mode));
    }
    logger.info(`Created ${this.workers.length} workers (mode: ${mode})`, {}, 'System', { console: true });
  }

  /**
   * Start periodic cleanup of old tasks
   * @private
   */
  _startCleanup() {
    // Cleanup every 5 minutes
    this.cleanupInterval = setInterval(() => {
      const cleared = this.store.cleanup(3600000); // 1 hour
      if (cleared > 0) {
        logger.debug(`Cleaned up ${cleared} old tasks`);
      }
    }, 300000);
  }

  /**
   * Create a new task
   * @param {string} type - Task type (image, audio, video)
   * @param {Buffer|string} input - Input data
   * @param {Object} options - Processing options
   * @param {Object} [progressReporter] - Optional ProgressReporter instance (uses default if not provided)
   * @returns {Task}
   */
  createTask(type, input, options, progressReporter = null) {
    const id = uuidv4();
    const reporter = progressReporter || ProgressReporter;
    const task = new Task(id, type, input, options, reporter);

    this.store.add(task);
    logger.info('Task created', { taskId: id, type, optionsKeys: Object.keys(options || {}) });

    return task;
  }

  /**
   * Submit a task to the queue for processing
   * @param {Task} task
   * @returns {Promise<Object>} - Processing result
   */
  async submitTask(task) {
    return this.queue.enqueue(task);
  }

  /**
   * Start processing a task (called by queue when slot available)
   * @param {Task} task
   */
  async startTask(task) {
    logger.info('Task starting', { taskId: task.id, type: task.type, mode: task.options?.mode, status: task.status });
    // Find an available worker
    const worker = this.workers.find((w) => !w.activeTask);
    if (worker) {
      await worker.process(task);
    } else {
      // This shouldn't happen if queue is working correctly
      logger.error('No available worker', { taskId: task.id });
      throw new Error('No available worker');
    }
  }

  /**
   * Get a task by ID
   * @param {string} id
   * @returns {Task|null}
   */
  getTask(id) {
    return this.store.get(id);
  }

  /**
   * Cancel a pending or running task
   * @param {string} id
   * @returns {boolean}
   */
  cancelTask(id) {
    const task = this.store.get(id);
    if (!task) return false;

    if (task.status === TaskStatus.PENDING) {
      this.queue.cancel(id);
      return true;
    }

    if (task.status === TaskStatus.RUNNING) {
      // Find the worker processing this task and kill it
      const worker = this.workers.find((w) => w.activeTask?.id === id);
      if (worker) {
        worker.cancel();
        return true;
      }
    }

    return false;
  }

  /**
   * Get all tasks
   * @returns {Task[]}
   */
  getAllTasks() {
    return this.store.getAll();
  }

  /**
   * Get tasks by status
   * @param {string} status
   * @returns {Task[]}
   */
  getTasksByStatus(status) {
    return this.store.getByStatus(status);
  }

  /**
   * Get queue statistics
   * @returns {Object}
   */
  getStats() {
    return {
      queue: {
        length: this.queue.getQueueLength(),
        running: this.queue.getRunningCount(),
        maxConcurrent: config.maxConcurrentTasks,
      },
      tasks: this.store.getStats(),
      workers: {
        total: this.workers.length,
        active: this.workers.filter((w) => w.activeTask).length,
      },
    };
  }

  /**
   * Shutdown the task manager
   */
  shutdown() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }

    // Clear the queue
    const cleared = this.queue.clear();
    logger.info(`TaskManager shutdown, cleared ${cleared} queued tasks`);
  }
}

// Singleton instance
export const taskManager = new TaskManager();
