import { v4 as uuidv4 } from '../utils/uuid.js';

/**
 * Manages SSE connections for progress reporting.
 * Uses generic Sender interface (SseConnection).
 * Supports linking SSE connections to internal job IDs for progress forwarding.
 */
class ProgressReporter {
  #connections = new Map();
  #jobLinks = new Map(); // sseJobId -> internal jobId

  /**
   * Create a new job with SSE connection.
   * @param {Sender} sender - Object implementing Sender interface
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
      this.#jobLinks.delete(jobId);
    });

    return jobId;
  }

  /**
   * Link an SSE connection to an internal job ID.
   * Progress events for the internal job will be forwarded to this SSE connection.
   * @param {string} sseJobId - SSE connection ID
   * @param {string} internalJobId - Internal job ID
   */
  linkJob(sseJobId, internalJobId) {
    if (this.#connections.has(sseJobId)) {
      this.#jobLinks.set(sseJobId, internalJobId);
    }
  }

  /**
   * Get internal job ID linked to an SSE connection.
   * @param {string} sseJobId
   * @returns {string|null}
   */
  getLinkedJob(sseJobId) {
    return this.#jobLinks.get(sseJobId) || null;
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
      this.#jobLinks.delete(jobId);
    }
  }

  /**
   * Get active connection count.
   * @returns {number}
   */
  get activeConnections() {
    return this.#connections.size;
  }
}

export default new ProgressReporter();