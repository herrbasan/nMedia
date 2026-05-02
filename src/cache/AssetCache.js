import fs from 'fs';
import path from 'path';
import { createReadStream } from 'fs';
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
 * @property {string} storagePath - Absolute path on disk
 * @property {number} createdAt - Unix timestamp (ms)
 * @property {number} expiresAt - Unix timestamp (ms)
 * @property {number|null} retrievedAt - Unix timestamp when first retrieved
 * @property {number} lastAccessed - Unix timestamp (ms) for LRU
 * @property {Object} metadata
 */

/**
 * Disk-backed asset storage with TTL management and LRU eviction.
 * Files stored on disk, metadata tracked in memory.
 * Supports Range requests for partial downloads.
 */
export class AssetCache {
  constructor() {
    /** @type {Map<string, AssetEntry>} */
    this.assets = new Map();
    this.cacheDir = config.cacheDir;
    this.ttl = (config.cacheTtl || 3600) * 1000;
    this.maxSize = config.cacheMaxSize || 10737418240;
    this.currentSize = 0;
    this.cleanupInterval = null;
    this.persistPath = path.join(this.cacheDir, 'assets.json');

    this._ensureCacheDir();
    this._loadPersisted();
    this._startCleanup();
  }

  /**
   * Load persisted asset metadata from JSON and reconcile with files on disk.
   * Removes orphaned files (on disk but not in metadata) and stale metadata entries
   * (in metadata but file missing or expired).
   * @private
   */
  _loadPersisted() {
    let persisted = [];
    try {
      if (fs.existsSync(this.persistPath)) {
        persisted = JSON.parse(fs.readFileSync(this.persistPath, 'utf8'));
      }
    } catch (err) {
      logger.warn('Failed to load persisted asset cache', { error: err.message });
    }

    const now = Date.now();
    const knownFiles = new Set();
    let loaded = 0;
    let removed = 0;

    for (const entry of persisted) {
      if (!entry.storagePath || !fs.existsSync(entry.storagePath)) {
        logger.info('AssetCache: removing stale entry (file missing)', { id: entry.id, path: entry.storagePath });
        removed++;
        continue;
      }
      if (now > entry.expiresAt) {
        logger.info('AssetCache: removing expired file', { id: entry.id, path: entry.storagePath, expiredAt: new Date(entry.expiresAt).toISOString() });
        try { fs.unlinkSync(entry.storagePath); } catch {}
        removed++;
        continue;
      }
      const stat = fs.statSync(entry.storagePath);
      entry.size = stat.size;
      entry.lastAccessed = entry.lastAccessed || now;
      this.assets.set(entry.id, entry);
      this.currentSize += stat.size;
      knownFiles.add(path.basename(entry.storagePath));
      loaded++;
    }

    // Remove orphaned files on disk that are not in metadata
    try {
      const diskFiles = fs.readdirSync(this.cacheDir);
      for (const file of diskFiles) {
        if (file === 'assets.json') continue;
        if (!knownFiles.has(file)) {
          const filePath = path.join(this.cacheDir, file);
          try {
            const stat = fs.statSync(filePath);
            if (stat.isFile()) {
              logger.info('AssetCache: removing orphan file', { file, size: stat.size });
              fs.unlinkSync(filePath);
              removed++;
            }
          } catch {}
        }
      }
    } catch (err) {
      logger.warn('Failed to scan cache directory for orphans', { error: err.message });
    }

    // Recalculate currentSize to be accurate
    this.currentSize = 0;
    for (const asset of this.assets.values()) {
      try {
        const stat = fs.statSync(asset.storagePath);
        this.currentSize += stat.size;
        asset.size = stat.size;
      } catch {
        logger.info('AssetCache: removing stale entry during recalc', { id: asset.id });
        this.assets.delete(asset.id);
      }
    }

    logger.info('AssetCache loaded', { loaded, removed, currentSize: this.currentSize, cacheDir: this.cacheDir });
  }

  /**
   * Persist asset metadata to JSON.
   * @private
   */
  _persist() {
    try {
      const data = Array.from(this.assets.values());
      fs.writeFileSync(this.persistPath, JSON.stringify(data, null, 2));
    } catch (err) {
      logger.warn('Failed to persist asset cache', { error: err.message });
    }
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
   * Store a buffer as an asset.
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

    fs.writeFileSync(storagePath, buffer);

    const asset = {
      id,
      type,
      mimeType,
      size: buffer.length,
      storagePath,
      createdAt: now,
      expiresAt: now + this.ttl,
      retrievedAt: null,
      lastAccessed: now,
      metadata,
    };

    this.assets.set(id, asset);
    this.currentSize += buffer.length;

    if (this.currentSize > this.maxSize) {
      this._enforceMaxSize();
    }

    this._persist();
    logger.info('Asset stored', { id, type, size: buffer.length, mimeType, ttlSeconds: this.ttl / 1000 });
    return asset;
  }

  /**
   * Store a file from disk path as an asset (no buffer copy).
   * @param {'image'|'audio'|'video'} type
   * @param {string} sourcePath - Path to source file
   * @param {string} mimeType - MIME type
   * @param {Object} [metadata] - Additional metadata
   * @returns {AssetEntry}
   */
  storeFile(type, sourcePath, mimeType, metadata = {}) {
    const id = uuidv4();
    const extension = this._getExtension(mimeType);
    const storagePath = this._getStoragePath(id, extension);
    const now = Date.now();

      // Use rename for true zero-copy flow locally. Fallback to copy if cross-device.
      try {
        fs.renameSync(sourcePath, storagePath);
      } catch (err) {
        if (err.code === 'EXDEV') {
          fs.copyFileSync(sourcePath, storagePath);
          fs.unlinkSync(sourcePath);
        } else {
          throw err;
        }
      }
      const stat = fs.statSync(storagePath);
      
      const asset = {
        id,
        type,
        mimeType,
        size: stat.size,
        storagePath,
        createdAt: now,
      expiresAt: now + this.ttl,
      retrievedAt: null,
      lastAccessed: now,
      metadata,
    };

    this.assets.set(id, asset);
    this.currentSize += stat.size;

    if (this.currentSize > this.maxSize) {
      this._enforceMaxSize();
    }

    this._persist();
    logger.info('Asset stored from file', { id, type, size: stat.size, sourcePath });
    return asset;
  }

  /**
   * Enforce max cache size via LRU eviction.
   * @private
   */
  _enforceMaxSize() {
    const sorted = Array.from(this.assets.values()).sort((a, b) => a.lastAccessed - b.lastAccessed);
    let evicted = 0;

    for (const asset of sorted) {
      if (this.currentSize <= this.maxSize * 0.8) break;
      logger.info('AssetCache: evicting LRU asset', { id: asset.id, type: asset.type, size: asset.size, lastAccessed: new Date(asset.lastAccessed).toISOString() });
      this._deleteFile(asset);
      this.assets.delete(asset.id);
      evicted++;
    }

    if (evicted > 0) {
      logger.info('AssetCache: LRU eviction complete', { evicted, currentSize: this.currentSize });
    }
  }

  /**
   * Get an asset by ID.
   * @param {string} id
   * @returns {AssetEntry|null}
   */
  get(id) {
    const asset = this.assets.get(id);
    if (!asset) {
      logger.info('Asset cache miss', { id });
      return null;
    }

    if (Date.now() > asset.expiresAt) {
      logger.info('Asset expired', { id, expiredAt: new Date(asset.expiresAt).toISOString() });
      this.delete(id);
      return null;
    }

    asset.lastAccessed = Date.now();
    logger.info('Asset cache hit', { id, type: asset.type, size: asset.size });
    return asset;
  }

  /**
   * Get asset file buffer (for backward compatibility).
   * Use getStream() for large files.
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

    return fs.readFileSync(asset.storagePath);
  }

  /**
   * Get readable stream for an asset. Supports Range requests.
   * @param {string} id
   * @param {Object} [range] - { start, end } for partial reads
   * @returns {import('fs').ReadStream|null}
   */
  getStream(id, range = null) {
    const asset = this.get(id);
    if (!asset) return null;

    if (!fs.existsSync(asset.storagePath)) {
      this.delete(id);
      return null;
    }

    const opts = {};
    if (range && typeof range.start === 'number') {
      opts.start = range.start;
      if (typeof range.end === 'number') {
        opts.end = range.end;
      }
    }

    return createReadStream(asset.storagePath, opts);
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

    this._persist();
    logger.info('Asset marked as retrieved', { id, expiresAt: asset.expiresAt });
    return true;
  }

  /**
   * Delete an asset.
   * @param {string} id
   * @returns {boolean}
   */
  delete(id) {
    const asset = this.assets.get(id);
    if (!asset) return false;

    this._deleteFile(asset);
    this.assets.delete(id);
    this._persist();
    logger.info('Asset deleted', { id });
    return true;
  }

  /**
   * Delete the file for an asset and update size tracking.
   * @param {AssetEntry} asset
   * @private
   */
  _deleteFile(asset) {
    try {
      if (asset.storagePath && fs.existsSync(asset.storagePath)) {
        const stat = fs.statSync(asset.storagePath);
        this.currentSize -= stat.size;
        fs.unlinkSync(asset.storagePath);
      }
    } catch (err) {
      logger.warn('Failed to delete asset file', { assetId: asset.id, error: err.message });
    }
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
    this._persist();
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
    const toDelete = [];

    for (const [id, asset] of this.assets) {
      if (now > asset.expiresAt) {
        toDelete.push(id);
      }
    }

    for (const id of toDelete) {
      const asset = this.assets.get(id);
      logger.info('AssetCache cleanup: deleting expired asset', { id, type: asset?.type, size: asset?.size, expiredAt: new Date(asset?.expiresAt).toISOString() });
      if (this.delete(id)) cleaned++;
    }

    if (cleaned > 0) {
      logger.info(`AssetCache cleanup complete`, { cleaned, currentSize: this.currentSize });
    }

    return cleaned;
  }

  /**
   * Get cache statistics.
   * @returns {Object}
   */
  getStats() {
    return {
      totalAssets: this.assets.size,
      totalSizeBytes: this.currentSize,
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