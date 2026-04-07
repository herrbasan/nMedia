import { v4 as uuidv4 } from '../utils/uuid.js';

/**
 * Manages SSE connections for progress reporting.
 * Now uses generic Sender interface (SseConnection) instead of Express res.
 */
class ProgressReporter {
  #connections = new Map();

  /**
   * Create a new job with SSE connection.
   * @param {Sender} sender - Object implementing Sender interface (e.g., SseConnection)
   * @returns {string} - Job ID
   */
  createJob(sender) {
    const jobId = uuidv4();

    sender.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    sender.write('\n');

    this.#connections.set(jobId, sender);

    sender.onClose(() => {
      this.#connections.delete(jobId);
    });

    return jobId;
  }

  /**
   * Send progress event to a job.
   * @param {string|null} jobId - Job ID (can be null for no-op)
   * @param {string} event - Event type: start, progress, complete, error
   * @param {Object} data - Event data
   */
  send(jobId, event, data = {}) {
    if (!jobId) return;

    const sender = this.#connections.get(jobId);
    if (!sender) return;

    const payload = JSON.stringify({ event, ...data });
    sender.write(`event: ${event}\n`);
    sender.write(`data: ${payload}\n\n`);
  }

  /**
   * Send progress percentage.
   * @param {string|null} jobId - Job ID (can be null for no-op)
   * @param {number} percent - 0-100
   * @param {string} message
   */
  progress(jobId, percent, message = '') {
    if (!jobId) return;
    this.send(jobId, 'progress', { percent, message });
  }

  /**
   * Mark job as complete.
   * @param {string|null} jobId - Job ID (can be null for no-op)
   * @param {Object} result
   */
  complete(jobId, result) {
    if (!jobId) return;
    this.send(jobId, 'complete', { result });
    this.close(jobId);
  }

  /**
   * Mark job as errored.
   * @param {string|null} jobId - Job ID (can be null for no-op)
   * @param {string} error
   */
  error(jobId, error) {
    if (!jobId) return;
    this.send(jobId, 'error', { error });
    this.close(jobId);
  }

  /**
   * Close a job connection.
   * @param {string} jobId
   */
  close(jobId) {
    const sender = this.#connections.get(jobId);
    if (sender) {
      sender.end();
      this.#connections.delete(jobId);
    }
  }
}

export default new ProgressReporter();