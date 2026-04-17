import logger from '../utils/logger.js';

/**
 * Task status enum
 */
export const TaskStatus = {
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

/**
 * Represents a processing task.
 */
export class Task {
  /**
   * @param {string} id - Unique task ID (UUID)
   * @param {string} type - Task type (image, audio, video)
   * @param {Buffer|string} input - Input data (buffer or base64)
   * @param {Object} options - Processing options
   * @param {Object} progressReporter - ProgressReporter instance for SSE updates
   */
  constructor(id, type, input, options, progressReporter) {
    this.id = id;
    this.type = type;
    this.input = input;
    this.options = options;
    this.progressReporter = progressReporter;
    this.status = TaskStatus.PENDING;
    this.createdAt = Date.now();
    this.startedAt = null;
    this.completedAt = null;
    this.result = null;
    this.error = null;
    this.percent = 0;
    /** @type {string|null} - Asset ID if result was stored in cache */
    this.assetId = null;
    /** @type {string|null} - Optional filesystem path to write result to */
    this.outputPath = null;
  }

  /**
   * Mark task as running
   */
  start() {
    this.status = TaskStatus.RUNNING;
    this.startedAt = Date.now();
    logger.info('Task started', { taskId: this.id, type: this.type, mode: this.options?.mode });
    this.progressReporter?.send(this.id, 'start', { type: this.type });
  }

  /**
   * Update task progress
   * @param {number} percent - 0-100
   * @param {string} message - Progress message
   */
  updateProgress(percent, message = '') {
    this.percent = percent;
    this.progressReporter?.progress(this.id, percent, message);
  }

  /**
   * Mark task as completed
   * @param {Object} result - Processing result
   */
  complete(result, assetId = null) {
    this.status = TaskStatus.COMPLETED;
    this.completedAt = Date.now();
    this.result = result;
    logger.info('Task marking complete', { taskId: this.id, assetId, duration: this.getDuration() });
    this.progressReporter?.complete(this.id, { metadata: result.metadata, assetId });
  }

  /**
   * Set the cached asset ID for this task's result
   * @param {string} assetId
   */
  setAssetId(assetId) {
    this.assetId = assetId;
  }

  /**
   * Mark task as failed
   * @param {string} error - Error message
   */
  fail(error) {
    this.status = TaskStatus.FAILED;
    this.completedAt = Date.now();
    this.error = error;
    logger.info('Task failed', { taskId: this.id, error, duration: this.getDuration() });
    this.progressReporter?.error(this.id, error);
  }

  /**
   * Mark task as cancelled
   */
  cancel() {
    if (this.status === TaskStatus.PENDING) {
      this.status = TaskStatus.CANCELLED;
      this.completedAt = Date.now();
      this.progressReporter?.send(this.id, 'cancelled', {});
      this.progressReporter?.close(this.id);
    }
  }

  /**
   * Get task summary for API responses
   * @returns {Object}
   */
  toJSON() {
    return {
      id: this.id,
      type: this.type,
      status: this.status,
      percent: this.percent,
      createdAt: this.createdAt,
      startedAt: this.startedAt,
      completedAt: this.completedAt,
      error: this.error,
      assetId: this.assetId,
      metadata: this.result?.metadata || null,
    };
  }

  /**
   * Get task duration in ms
   * @returns {number|null}
   */
  getDuration() {
    if (!this.startedAt) return null;
    const end = this.completedAt || Date.now();
    return end - this.startedAt;
  }
}
