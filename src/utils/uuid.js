import { randomUUID } from 'crypto';

/**
 * Generate a UUID v4 string
 * @returns {string}
 */
export function v4() {
  return randomUUID();
}
