import { Sender } from './Sender.js';

/**
 * SSE-specific sender implementation.
 * Wraps http.ServerResponse and provides SSE formatting.
 */
export class SseConnection extends Sender {
  #response;
  #closed = false;

  constructor(response) {
    super();
    this.#response = response;
  }

  writeHead(statusCode, headers) {
    if (!this.#closed) {
      this.#response.writeHead(statusCode, headers);
    }
  }

  write(data) {
    if (!this.#closed && data !== undefined && data !== null) {
      if (typeof data === 'string') {
        this.#response.write(data);
      } else if (Buffer.isBuffer(data)) {
        this.#response.write(data);
      }
    }
  }

  end() {
    if (!this.#closed) {
      this.#closed = true;
      this.#response.end();
    }
  }

  onClose(callback) {
    this.#response.on('close', () => {
      callback();
    });
  }

  /**
   * Send an SSE-formatted event.
   * @param {string} eventType - Event type (connected, progress, error, etc.)
   * @param {Object} data - Event data
   */
  sendEvent(eventType, data) {
    this.write(`event: ${eventType}\n`);
    this.write(`data: ${JSON.stringify(data)}\n\n`);
  }
}