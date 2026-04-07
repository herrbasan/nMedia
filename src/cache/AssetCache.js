import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from '../utils/uuid.js';
import logger from '../utils/logger.js';
import config from '../config/config.js';

/**
 * Asset cache entry model
 * @typedef {Object} AssetEntry
 * @property {string} id - UUID v4
 * @property {'image'|'audio'|'video'} type
 * @property {string} mimeType
 * @property {number} size - Bytes
 * @property {string} storagePath - Relative to cache root
 * @property {number} createdAt - Unix timestamp
 * @property {number} expiresAt - Unix timestamp
 * @property {number|null} retrievedAt - Unix timestamp when first retrieved
 * @property {Object} metadata
 */

/**
 * In-memory asset metadata store with TTL-based disk storage.
 */
export class AssetCache {
  constructor() {
    /** @type {Map<string, AssetEntry>} */
    this.assets = new Map();
    this.cacheDir = config.cacheDir;
    this.ttl = (config.cacheTtl || 3600) * 1000; // Convert to ms
    this.maxSize = config.cacheMaxSize || 10737418240; // 10GB default
    this.cleanupInterval = null;

    // Ensure cache directory exists
    this._ensureCacheDir();

    // Start background cleanup
    this._startCleanup();
  }

  /**
   * Ensure cache directory exists
   * @private
   */
  _ensureCacheDir() {
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
      logger.info(`Created cache directory: ${this.cacheDir}`);
    }
  }

  /**
   * Start periodic cleanup of expired assets
   * @private
   */
  _startCleanup() {
    // Cleanup every 5 minutes
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, 300000);
  }

  /**
   * Generate storage path for an asset
   * @param {string} id - Asset ID
   * @param {string} extension - File extension
   * @returns {string}
   */
  _getStoragePath(id, extension) {
    return path.join(this.cacheDir, `${id}.${extension}`);
  }

  /**
   * Get extension from MIME type
   * @param {string} mimeType
   * @returns {string}
   */
  _getExtension(mimeType) {
    const mimeToExt = {
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/webp': 'webp',
      'image/gif': 'gif',
      'image/avif': 'avif',
      'image/heic': 'heic',
      'image/heif': 'heif',
      'audio/mpeg': 'mp3',
      'audio/mp3': 'mp3',
      'audio/wav': 'wav',
      'audio/ogg': 'ogg',
      'audio/aac': 'aac',
      'audio/flac': 'flac',
      'video/mp4': 'mp4',
      'video/webm': 'webm',
      'video/ogg': 'ogv',
      'video/avi': 'avi',
      'video/mkv': 'mkv',
    };
    return mimeToExt[mimeType] || 'bin';
  }

  /**
   * Get MIME type from extension
   * @param {string} extension
   * @returns {string}
   */
  _getMimeType(extension) {
    const extToMime = {
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      webp: 'image/webp',
      gif: 'image/gif',
      avif: 'image/avif',
      heic: 'image/heic',
      heif: 'image/heif',
      mp3: 'audio/mpeg',
      wav: 'audio/wav',
      ogg: 'audio/ogg',
      aac: 'audio/aac',
      flac: 'audio/flac',
      mp4: 'video/mp4',
      webm: 'video/webm',
      ogv: 'video/ogg',
      avi: 'video/avi',
      mkv: 'video/mkv',
    };
    return extToMime[extension.toLowerCase()] || 'application/octet-stream';
  }

  /**
   * Store an asset in cache
   * @param {'image'|'audio'|'video'} type
   * @param {Buffer} buffer - Asset data
   * @param {string} mimeType - MIME type
   * @param {Object} [metadata] - Additional metadata
   * @returns {AssetEntry}
   */
  store(type, buffer, mimeType, metadata = {}) {
    const id = uuidv4();
    const extension = this._getExtension(mimeType);
    const storagePath = this._getStoragePath(id, extension);
    const now = Date.now();

    // Write file to disk
    fs.writeFileSync(storagePath, buffer);

    // Create asset entry
    /** @type {AssetEntry} */
    const asset = {
      id,
      type,
      mimeType,
      size: buffer.length,
      storagePath,
      createdAt: now,
      expiresAt: now + this.ttl,
      metadata,
    };

    this.assets.set(id, asset);
    logger.debug('Asset cached', { id, type, size: buffer.length });

    return asset;
  }

  /**
   * Get an asset by ID
   * @param {string} id
   * @returns {AssetEntry|null}
   */
  get(id) {
    const asset = this.assets.get(id);
    if (!asset) return null;

    // Check if expired
    if (Date.now() > asset.expiresAt) {
      this.delete(id);
      return null;
    }

    return asset;
  }

  /**
   * Get asset file buffer
   * @param {string} id
   * @returns {Buffer|null}
   */
  getBuffer(id) {
    const asset = this.get(id);
    if (!asset) return null;

    if (!fs.existsSync(asset.storagePath)) {
      this.delete(id);
      return null;
    }

    // Mark as retrieved (reduces TTL for early cleanup)
    this.markRetrieved(id);

    return fs.readFileSync(asset.storagePath);
  }

  /**
   * Mark an asset as retrieved by the client
   * Sets TTL to 0 so it will be cleaned up on next cycle
   * @param {string} id
   * @returns {boolean}
   */
  markRetrieved(id) {
    const asset = this.assets.get(id);
    if (!asset) return false;

    // Only mark once
    if (asset.retrievedAt) return true;

    asset.retrievedAt = Date.now();
    asset.expiresAt = Date.now(); // Expire immediately (will be cleaned on next cycle)

    logger.debug('Asset marked as retrieved', { id, expiresAt: asset.expiresAt });
    return true;
  }

  /**
   * Delete an asset
   * @param {string} id
   * @returns {boolean}
   */
  delete(id) {
    const asset = this.assets.get(id);
    if (!asset) return false;

    // Delete file if exists
    if (fs.existsSync(asset.storagePath)) {
      fs.unlinkSync(asset.storagePath);
    }

    this.assets.delete(id);
    logger.debug('Asset deleted', { id });
    return true;
  }

  /**
   * Clear all assets
   * @returns {number} - Number of assets cleared
   */
  clear() {
    let cleared = 0;
    for (const id of this.assets.keys()) {
      if (this.delete(id)) cleared++;
    }
    logger.info(`Asset cache cleared, ${cleared} assets removed`);
    return cleared;
  }

  /**
   * Clean up expired assets
   * @returns {number} - Number of assets cleaned up
   */
  cleanup() {
    const now = Date.now();
    let cleaned = 0;

    for (const [id, asset] of this.assets) {
      if (now > asset.expiresAt) {
        if (this.delete(id)) cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.debug(`Cleaned up ${cleaned} expired assets`);
    }

    return cleaned;
  }

  /**
   * Get cache statistics
   * @returns {Object}
   */
  getStats() {
    let totalSize = 0;
    for (const asset of this.assets.values()) {
      totalSize += asset.size;
    }

    return {
      totalAssets: this.assets.size,
      totalSizeBytes: totalSize,
      maxSizeBytes: this.maxSize,
      ttlSeconds: this.ttl / 1000,
      cacheDir: this.cacheDir,
    };
  }

  /**
   * Get all assets (for listing)
   * @returns {AssetEntry[]}
   */
  getAll() {
    return Array.from(this.assets.values());
  }

  /**
   * Get assets by type
   * @param {'image'|'audio'|'video'} type
   * @returns {AssetEntry[]}
   */
  getByType(type) {
    return this.getAll().filter((a) => a.type === type);
  }

  /**
   * Shutdown the cache (stop cleanup interval)
   */
  shutdown() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    logger.info('AssetCache shutdown');
  }
}

// Singleton instance
export const assetCache = new AssetCache();