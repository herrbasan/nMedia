import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Simple static file server utility.
 * Maps file extensions to MIME types and streams files efficiently.
 */
export class StaticFileServer {
  #basePath;

  static MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.eot': 'application/vnd.ms-fontobject',
  };

  /**
   * @param {string} basePath - Absolute base directory for file serving
   */
  constructor(basePath) {
    this.#basePath = basePath;
  }

  /**
   * Serve a static file.
   * @param {Context} ctx - Request context
   * @param {string} relativePath - Path relative to base directory
   * @returns {boolean} - Whether file was found and served
   */
  async serve(ctx, relativePath) {
    // Security: prevent directory traversal
    const safePath = path.normalize(relativePath).replace(/^(\.\.(\/|\$))+/g, '');
    const fullPath = path.join(this.#basePath, safePath);

    // Ensure path is within base directory
    if (!fullPath.startsWith(this.#basePath)) {
      return false;
    }

    // Check if file exists and is readable
    try {
      const stats = await fs.promises.stat(fullPath);
      
      if (!stats.isFile()) {
        return false;
      }

      // Determine MIME type
      const ext = path.extname(fullPath).toLowerCase();
      const mimeType = StaticFileServer.MIME_TYPES[ext] || 'application/octet-stream';

      // Stream file
      const res = ctx.rawResponse;
      res.writeHead(200, {
        'Content-Type': mimeType,
        'Content-Length': stats.size,
        'X-Powered-By': 'MediaService',
        'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
      });

      const stream = fs.createReadStream(fullPath);
      
      return new Promise((resolve, reject) => {
        stream.pipe(res);
        stream.on('error', (err) => {
          reject(err);
        });
        res.on('finish', () => {
          resolve(true);
        });
      });
    } catch (err) {
      if (err.code === 'ENOENT') {
        return false;
      }
      throw err;
    }
  }

  /**
   * Create a route handler for serving a directory.
   * @param {string} basePath - Absolute base directory
   * @param {string} [indexFile] - Default file to serve for directories
   * @returns {Function} - Route handler (ctx) => Promise<void>
   */
  static createHandler(basePath, indexFile = 'index.html') {
    const server = new StaticFileServer(basePath);
    
    return async (ctx) => {
      // Build relative path from remaining URL path after route prefix
      let relativePath = ctx.params['*'] || '';
      
      // If path is empty or ends with /, serve index file
      if (!relativePath || relativePath.endsWith('/')) {
        relativePath = path.join(relativePath, indexFile);
      }

      const served = await server.serve(ctx, relativePath);
      
      if (!served) {
        ctx.error(404, 'File not found');
      }
    };
  }
}
