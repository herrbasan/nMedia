import { createHash, randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import { Sender } from './Sender.js';

const WS_MAGIC_STRING = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/**
 * Minimal WebSocket server with binary frame support.
 * Built on raw Node.js net/socket (no external dependencies).
 */
export class WebSocketServer extends EventEmitter {
  constructor() {
    super();
    this.connections = new Map();
  }

  /**
   * Handle an HTTP upgrade request.
   * @param {http.IncomingMessage} req
   * @param {net.Socket} socket
   * @param {Buffer} head
   */
  handleUpgrade(req, socket, head) {
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.destroy();
      return;
    }

    const acceptKey = createHash('sha1')
      .update(key + WS_MAGIC_STRING)
      .digest('base64');

    const responseHeaders = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey}`,
      '',
      '',
    ];

    socket.write(responseHeaders.join('\r\n'));

    const conn = new WebSocketConnection(socket);
    this.connections.set(conn.id, conn);

    conn.on('close', () => {
      this.connections.delete(conn.id);
    });

    conn.on('message', (message) => {
      this.emit('message', conn, message);
    });

    this.emit('connection', conn, req);
  }

  broadcast(data) {
    for (const conn of this.connections.values()) {
      conn.send(data);
    }
  }

  closeAll() {
    for (const conn of this.connections.values()) {
      conn.close(1001, 'Server shutting down');
    }
    this.connections.clear();
  }
}

/**
 * Represents a single WebSocket connection.
 * Implements Sender interface for ProgressReporter compatibility.
 */
export class WebSocketConnection extends Sender {
  #socket;
  #buffer = Buffer.alloc(0);
  #closed = false;
  #id;

  constructor(socket) {
    super();
    this.#socket = socket;
    this.#id = randomUUID();

    socket.on('data', (chunk) => {
      this.#buffer = Buffer.concat([this.#buffer, chunk]);
      this.#parseFrames();
    });

    socket.on('close', () => this.#cleanup());
    socket.on('error', (err) => {
      this.emit('error', err);
      this.#cleanup();
    });
  }

  get id() {
    return this.#id;
  }

  writeHead() {
    // No-op for WebSocket
  }

  write(data) {
    if (this.#closed) return;
    if (typeof data === 'string') {
      this.#sendFrame(0x1, Buffer.from(data, 'utf8'));
    } else if (Buffer.isBuffer(data)) {
      this.#sendFrame(0x2, data);
    }
  }

  end() {
    this.close();
  }

  onClose(callback) {
    this.once('close', callback);
  }

  /**
   * Send a structured event as JSON over WebSocket.
   * @param {string} event - Event type
   * @param {Object} data - Event data
   */
  sendEvent(event, data) {
    this.send({ type: event, ...data });
  }

  send(data) {
    if (this.#closed) return;
    if (typeof data === 'string') {
      this.#sendFrame(0x1, Buffer.from(data, 'utf8'));
    } else if (Buffer.isBuffer(data)) {
      this.#sendFrame(0x2, data);
    } else {
      this.#sendFrame(0x1, Buffer.from(JSON.stringify(data), 'utf8'));
    }
  }

  ping() {
    if (!this.#closed) {
      this.#sendFrame(0x9, Buffer.alloc(0));
    }
  }

  close(code = 1000, reason = '') {
    if (this.#closed) return;

    const payload = Buffer.allocUnsafe(2 + Buffer.byteLength(reason, 'utf8'));
    payload.writeUInt16BE(code, 0);
    payload.write(reason, 2, 'utf8');
    this.#sendFrame(0x8, payload);
    this.#cleanup();
  }

  #sendFrame(opcode, payload) {
    let frame;
    const payloadLength = payload.length;

    if (payloadLength < 126) {
      frame = Buffer.allocUnsafe(2 + payloadLength);
      frame[0] = 0x80 | opcode;
      frame[1] = payloadLength;
      payload.copy(frame, 2);
    } else if (payloadLength < 65536) {
      frame = Buffer.allocUnsafe(4 + payloadLength);
      frame[0] = 0x80 | opcode;
      frame[1] = 126;
      frame.writeUInt16BE(payloadLength, 2);
      payload.copy(frame, 4);
    } else {
      frame = Buffer.allocUnsafe(10 + payloadLength);
      frame[0] = 0x80 | opcode;
      frame[1] = 127;
      frame.writeBigUInt64BE(BigInt(payloadLength), 2);
      payload.copy(frame, 10);
    }

    this.#socket.write(frame);
  }

  #parseFrames() {
    while (this.#buffer.length >= 2) {
      const byte0 = this.#buffer[0];
      const byte1 = this.#buffer[1];
      const opcode = byte0 & 0x0f;
      const masked = !!(byte1 & 0x80);
      let payloadLength = byte1 & 0x7f;
      let offset = 2;

      if (payloadLength === 126) {
        if (this.#buffer.length < 4) return;
        payloadLength = this.#buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLength === 127) {
        if (this.#buffer.length < 10) return;
        const len = this.#buffer.readBigUInt64BE(2);
        if (len > Number.MAX_SAFE_INTEGER) {
          this.close(1009, 'Payload too large');
          return;
        }
        payloadLength = Number(len);
        offset = 10;
      }

      const maskKeyLength = masked ? 4 : 0;
      const totalLength = offset + maskKeyLength + payloadLength;

      if (this.#buffer.length < totalLength) return;

      let payload = this.#buffer.slice(offset + maskKeyLength, totalLength);

      if (masked) {
        const maskKey = this.#buffer.slice(offset, offset + 4);
        for (let i = 0; i < payload.length; i++) {
          payload[i] ^= maskKey[i % 4];
        }
      }

      this.#buffer = this.#buffer.slice(totalLength);

      switch (opcode) {
        case 0x1: // text
          this.emit('message', { type: 'text', data: payload.toString('utf8') });
          break;
        case 0x2: // binary
          this.emit('message', { type: 'binary', data: payload });
          break;
        case 0x8: // close
          this.#cleanup();
          return;
        case 0x9: // ping
          this.#sendFrame(0xa, payload);
          break;
        case 0xa: // pong
          break;
        default:
          break;
      }
    }
  }

  #cleanup() {
    if (this.#closed) return;
    this.#closed = true;
    this.#socket.destroy();
    this.emit('close');
  }
}
