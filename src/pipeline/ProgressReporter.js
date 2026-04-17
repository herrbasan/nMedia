import { v4 as uuidv4 } from '../utils/uuid.js';

/**
 * Manages SSE and WebSocket connections for progress reporting.
 * Uses generic Sender interface (SseConnection, WebSocketConnection).
 * Supports linking connections to internal job IDs for progress forwarding.
 */
class ProgressReporter {
  #connections = new Map();
  #jobLinks = new Map(); // connectionId -> internal jobId

  /**
   * Create a new job with SSE connection.
   * @param {Sender} sender - Object implementing Sender interface
   * @returns {string} - Connection ID
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
   * Register a generic connection (e.g., WebSocket).
   * @param {Sender} sender
   * @returns {string} - Connection ID
   */
  registerConnection(sender) {
    const connId = uuidv4();
    this.#connections.set(connId, sender);

    sender.onClose(() => {
      this.#connections.delete(connId);
      this.#jobLinks.delete(connId);
    });

    return connId;
  }

  /**
   * Link a connection to an internal job ID.
   * Progress events for the internal job will be forwarded to this connection.
   * @param {string} connectionId - Connection ID
   * @param {string} internalJobId - Internal job ID
   */
  linkJob(connectionId, internalJobId) {
    if (this.#connections.has(connectionId)) {
      this.#jobLinks.set(connectionId, internalJobId);
    }
  }

  /**
   * Get internal job ID linked to a connection.
   * @param {string} connectionId
   * @returns {string|null}
   */
  getLinkedJob(connectionId) {
    return this.#jobLinks.get(connectionId) || null;
  }

  /**
   * Send progress event to a job and all linked connections.
   * @param {string|null} jobId - Job ID (can be null for no-op)
   * @param {string} event - Event type: start, progress, complete, error
   * @param {Object} data - Event data
   */
  send(jobId, event, data = {}) {
    if (!jobId) return;

    // Send to direct connection if exists
    const directSender = this.#connections.get(jobId);
    if (directSender) {
      this.#sendToSender(directSender, event, data, jobId);
    }

    // Forward to all linked connections
    for (const [connId, linkedJobId] of this.#jobLinks) {
      if (linkedJobId === jobId) {
        const sender = this.#connections.get(connId);
        if (sender) {
          this.#sendToSender(sender, event, data, jobId);
        }
      }
    }
  }

  #sendToSender(sender, event, data, jobId) {
    if (typeof sender.sendEvent === 'function') {
      sender.sendEvent(event, { jobId, ...data });
    } else {
      const payload = JSON.stringify({ event, jobId, ...data });
      sender.write(`event: ${event}\n`);
      sender.write(`data: ${payload}\n\n`);
    }
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
