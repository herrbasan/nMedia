/**
 * Abstract interface for response senders.
 * ProgressReporter only depends on this interface,
 * not on Express or Node's http.ServerResponse directly.
 * This allows SSE, WebSockets, or other transports to be used interchangeably.
 */
export class Sender {
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
}