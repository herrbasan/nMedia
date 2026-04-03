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
    const ctx = new Context(req, res);

    try {
      // Log request
      logger.info(`${req.method} ${req.url}`);

      // Parse body for methods that typically have bodies
      if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
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
}