/**
 * Simple pattern-matching router.
 * Supports static segments and :param wildcards.
 *
 * @example
 * const router = new Router();
 * router.addRoute('GET', '/health', handleHealth);
 * router.addRoute('POST', '/v1/optimize/image/:action', handleImage);
 * const match = router.match('POST', '/v1/optimize/image/crop');
 * // match.handler = handleImage, match.params = { action: 'crop' }
 */
export class Router {
  #routes = [];

  /**
   * Add a route.
   * @param {string} method - HTTP method (GET, POST, etc.)
   * @param {string} pattern - Route pattern (e.g., '/health', '/v1/optimize/image/:action')
   * @param {Function} handler - Async function(ctx) {}
   */
  addRoute(method, pattern, handler) {
    const segments = pattern.split('/').filter(Boolean);
    this.#routes.push({
      method: method.toUpperCase(),
      pattern,
      segments,
      handler,
    });
  }

  /**
   * Match a request to a route.
   * @param {string} method - HTTP method
   * @param {string} path - Request path (without query string)
   * @returns {{ handler: Function, params: Object } | null}
   */
  match(method, path) {
    const pathSegments = path.split('/').filter(Boolean);

    for (const route of this.#routes) {
      if (route.method !== method.toUpperCase()) continue;

      if (route.segments.length !== pathSegments.length) continue;

      const params = {};
      let match = true;

      for (let i = 0; i < route.segments.length; i++) {
        const seg = route.segments[i];
        const pathSeg = pathSegments[i];

        if (seg.startsWith(':')) {
          // Parameter segment - capture
          params[seg.slice(1)] = decodeURIComponent(pathSeg);
        } else if (seg !== pathSeg) {
          match = false;
          break;
        }
      }

      if (match) {
        return { handler: route.handler, params };
      }
    }

    return null;
  }
}