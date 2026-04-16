import { extractBoundary, MultipartParser } from './MultipartParser.js';
import { SseConnection } from './SseConnection.js';
import ProgressReporter from '../pipeline/ProgressReporter.js';
import logger from '../utils/logger.js';

/**
 * Unified context object for route handlers.
 * Wraps http.IncomingMessage and http.ServerResponse.
 */
export class Context {
  #req;
  #res;
  #params = {};
  #body = null;
  #file = null;

  constructor(req, res) {
    this.#req = req;
    this.#res = res;
  }

  get method() {
    return this.#req.method;
  }

  get path() {
    return this.#req.url?.split('?')[0] || '/';
  }

  get query() {
    const url = new URL(this.#req.url, 'http://localhost');
    return Object.fromEntries(url.searchParams);
  }

  get headers() {
    return this.#req.headers;
  }

  get body() {
    return this.#body;
  }

  get file() {
    return this.#file;
  }

  get params() {
    return this.#params;
  }

  /**
   * Set route parameters extracted by Router.
   * @param {Object} params - Key-value pairs from route pattern
   */
  setParams(params) {
    this.#params = params;
  }

  /**
   * Parse request body based on Content-Type.
   */
  async parseBody() {
    const rawContentType = this.headers['content-type'] || '';
    const contentType = rawContentType.toLowerCase();

    if (contentType.includes('multipart/form-data')) {
      // Extract boundary from original (non-lowercased) header to preserve case
      const boundary = extractBoundary(rawContentType);
      if (!boundary) {
        throw new Error('Missing boundary in multipart/form-data');
      }

      const parser = new MultipartParser(boundary);
      const { fields, files } = await parser.parse(this.#req);

      this.#body = fields;
      this.#file = files.length > 0 ? files[0] : null;
    } else if (contentType.includes('application/json')) {
      const chunks = [];
      for await (const chunk of this.#req) {
        chunks.push(chunk);
      }
      this.#body = JSON.parse(Buffer.concat(chunks).toString());
    } else if (contentType.includes('application/x-www-form-urlencoded')) {
      const chunks = [];
      for await (const chunk of this.#req) {
        chunks.push(chunk);
      }
      const qs = new URLSearchParams(Buffer.concat(chunks).toString());
      this.#body = Object.fromEntries(qs);
    } else if (contentType.includes('text/')) {
      const chunks = [];
      for await (const chunk of this.#req) {
        chunks.push(chunk);
      }
      this.#body = Buffer.concat(chunks).toString();
    } else {
      // For other content types, just read as buffer
      const chunks = [];
      for await (const chunk of this.#req) {
        chunks.push(chunk);
      }
      this.#body = Buffer.concat(chunks);
    }
  }

  /**
   * Send JSON response.
   * @param {number} statusCode - HTTP status code
   * @param {Object} data - Response data
   */
  json(statusCode, data) {
    if (this.#res.headersSent) return;
    const body = JSON.stringify(data);
    this.#res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'X-Powered-By': 'MediaService',
      'Access-Control-Allow-Origin': '*',
    });
    this.#res.end(body);
  }

  /**
   * Send raw buffer response (file download).
   * @param {number} statusCode - HTTP status code
   * @param {Buffer} buffer - Response body
   * @param {string} mimeType - Content-Type
   * @param {string} [filename] - Optional Content-Disposition filename
   */
  send(statusCode, buffer, mimeType, filename) {
    if (this.#res.headersSent) return;
    const headers = {
      'Content-Type': mimeType,
      'Content-Length': buffer.length,
      'X-Powered-By': 'MediaService',
      'Access-Control-Allow-Origin': '*',
    };
    if (filename) {
      headers['Content-Disposition'] = `attachment; filename="${filename}"`;
    }
    this.#res.writeHead(statusCode, headers);
    this.#res.end(buffer);
  }

  /**
   * Create SSE job for progress reporting.
   * @returns {string} - Job ID
   */
  createSseJob() {
    const sseConnection = new SseConnection(this.#res);
    return ProgressReporter.createJob(sseConnection);
  }

  /**
   * Send error response and log.
   * @param {number} statusCode - HTTP status code
   * @param {string} message - Error message
   */
  error(statusCode, message) {
    if (this.#res.headersSent) {
      logger.error('Request error (headers already sent)', { statusCode, message, path: this.path });
      this.#res.destroy();
      return;
    }
    logger.error('Request error', { statusCode, message, path: this.path });
    this.json(statusCode, { error: message });
  }

  /**
   * Get the underlying raw response object.
   * Use sparingly - prefer json() or send() methods.
   */
  get rawResponse() {
    return this.#res;
  }

  /**
   * Get the underlying raw request object.
   * Use sparingly - for streaming uploads.
   */
  get rawRequest() {
    return this.#req;
  }
}