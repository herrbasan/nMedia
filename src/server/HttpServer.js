import { Context } from './Context.js';
import logger from '../utils/logger.js';
import config from '../config/config.js';

/**
 * HTTP server request handler.
 * Parses incoming requests, routes them, handles errors.
 */
export class HttpServer {
  /**
   * Handle an incoming HTTP request.
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   * @param {Router} router
   */
  static async handle(req, res, router) {
    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
      HttpServer.sendCors(res);
      res.writeHead(204);
      res.end();
      return;
    }

    const ctx = new Context(req, res);

    try {
      // Log request
      logger.info(`${req.method} ${req.url}`);

      // Parse body for methods that typically have bodies
      // Skip for /v1/upload - handler streams raw binary directly
      if (['POST', 'PUT', 'PATCH'].includes(req.method) && req.url !== '/v1/upload') {
        await ctx.parseBody();
      }

      // Match route
      const match = router.match(req.method, ctx.path);

      if (!match) {
        ctx.error(404, 'Not found');
        return;
      }

      ctx.setParams(match.params);

      // Execute handler
      await match.handler(ctx);
    } catch (err) {
      logger.error('Unhandled error', { error: err.message, stack: err.stack });

      // Check for file size exceeded
      if (err.message && err.message.includes('maxFileSize')) {
        ctx.error(413, `File too large. Max size: ${config.maxFileSizeMb}MB`);
        return;
      }

      ctx.error(500, err.message || 'Internal server error');
    }
  }

  /**
   * Send CORS headers
   */
  static sendCors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
}
