import { EventEmitter } from 'events';

/**
 * Abstract interface for response senders.
 * ProgressReporter only depends on this interface,
 * not on Express or Node's http.ServerResponse directly.
 * This allows SSE, WebSockets, or other transports to be used interchangeably.
 */
export class Sender extends EventEmitter {
  writeHead(statusCode, headers) {
    throw new Error('Not implemented');
  }

  write(data) {
    throw new Error('Not implemented');
  }

  end() {
    throw new Error('Not implemented');
  }

  onClose(callback) {
    throw new Error('Not implemented');
  }

  /**
   * Send a structured event. Default implementation writes SSE format.
   * Subclasses (WebSocket, etc.) should override for their protocol.
   * @param {string} event - Event type
   * @param {Object} data - Event data
   */
  sendEvent(event, data) {
    const payload = JSON.stringify({ event, ...data });
    this.write(`event: ${event}\n`);
    this.write(`data: ${payload}\n\n`);
  }
}
