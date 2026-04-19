import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from '../utils/uuid.js';
import logger from '../utils/logger.js';
import config from '../config/config.js';

/**
 * Job status enum
 */
export const JobStatus = {
  QUEUED: 'queued',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

/**
 * Upload entry
 * @typedef {Object} UploadEntry
 * @property {string} fileId - UUID
 * @property {string} tempPath - Path to uploaded file on disk
 * @property {string} originalFilename - Client-provided filename (sanitized)
 * @property {string} detectedType - Detected media type (image/audio/video)
 * @property {string} detectedMimeType - Detected MIME type
 * @property {number} size - File size in bytes
 * @property {number} createdAt - Unix timestamp (ms)
 * @property {number} expiresAt - Unix timestamp (ms)
 * @property {boolean} processed - Whether this upload has been used for processing
 */

/**
 * Job entry
 * @typedef {Object} JobEntry
 * @property {string} jobId - UUID
 * @property {string} [fileId] - Upload ID (Pattern B) or null for path-based (Pattern A)
 * @property {string} [inputPath] - Source file path (Pattern A) or null for upload-based
 * @property {string} processor - 'image', 'audio', or 'video'
 * @property {string} [mode] - Processing mode (e.g., 'extract_audio', 'extract_keyframes')
 * @property {Object} options - Processing options
 * @property {string} status - JobStatus value
 * @property {number} percent - 0-100
 * @property {string} message - Current progress message
 * @property {string|null} assetId - Result asset ID when completed
 * @property {string|null} error - Error message when failed
 * @property {string|null} outputPath - Optional filesystem path to write result to
 * @property {boolean} deleted - Whether this job has been purged from active list
 * @property {number} createdAt - Unix timestamp (ms)
 * @property {number|null} startedAt - Unix timestamp (ms)
 * @property {number|null} completedAt - Unix timestamp (ms)
 * @property {number} queuePosition - Position in queue when queued
 */

/**
 * Disk-backed job and upload store with persistence and startup recovery.
 * Tracks the ID chain: fileId → jobId → assetId
 */
export class JobStore {
  constructor() {
    /** @type {Map<string, UploadEntry>} */
    this.uploads = new Map();

    /** @type {Map<string, JobEntry>} */
    this.jobs = new Map();

    /** @type {Map<string, string>} fileId → jobId mapping */
    this.uploadToJob = new Map();

    this.storeDir = path.join(config.cacheDir, '..', 'jobs');
    this.uploadsDir = path.join(config.cacheDir, '..', 'uploads');
    this.persistPath = path.join(this.storeDir, 'jobs.json');
    this.uploadTTL = 3600000; // 1 hour for unprocessed uploads
    this.cleanupInterval = null;
    this.nextQueuePosition = 1;

    this._ensureDirs();
    this._loadPersisted();
    this._recover();
    this._startCleanup();
  }

  _ensureDirs() {
    if (!fs.existsSync(this.storeDir)) {
      fs.mkdirSync(this.storeDir, { recursive: true });
    }
    if (!fs.existsSync(this.uploadsDir)) {
      fs.mkdirSync(this.uploadsDir, { recursive: true });
    }
  }

  _loadPersisted() {
    try {
      if (fs.existsSync(this.persistPath)) {
        const data = JSON.parse(fs.readFileSync(this.persistPath, 'utf8'));

        if (data.uploads) {
          for (const upload of data.uploads) {
            this.uploads.set(upload.fileId, upload);
          }
        }

        if (data.jobs) {
          for (const job of data.jobs) {
            this.jobs.set(job.jobId, job);
            if (job.fileId) {
              this.uploadToJob.set(job.fileId, job.jobId);
            }
          }
        }

        if (data.nextQueuePosition) {
          this.nextQueuePosition = data.nextQueuePosition;
        }

        logger.info('Loaded persisted jobs', {
          uploads: this.uploads.size,
          jobs: this.jobs.size,
        }, 'System', { console: true });
      }
    } catch (err) {
      logger.warn('Failed to load persisted jobs', { error: err.message });
    }
  }

  /**
   * Recover state after restart.
   * - Jobs in 'processing' state are marked 'failed' (output likely corrupt)
   * - Jobs in 'queued' state remain queued (will be re-processed)
   */
  _recover() {
    let recovered = 0;

    for (const [jobId, job] of this.jobs) {
      if (job.status === JobStatus.PROCESSING) {
        job.status = JobStatus.FAILED;
        job.error = 'Service restarted during processing';
        job.completedAt = Date.now();
        recovered++;
        logger.warn('Recovered processing job marked as failed', { jobId });
      }
    }

    if (recovered > 0) {
      this._persist();
    }
  }

  _startCleanup() {
    this.cleanupInterval = setInterval(() => this._cleanup(), 300000);
    this.cleanupInterval.unref();
  }

  _cleanup() {
    const now = Date.now();
    let cleaned = 0;

    // Clean expired uploads
    for (const [fileId, upload] of this.uploads) {
      if (now > upload.expiresAt && !upload.processed) {
        this._deleteUploadFile(upload);
        this.uploads.delete(fileId);
        cleaned++;
      }
    }

    // Clean completed/failed/cancelled jobs older than 1 hour
    for (const [jobId, job] of this.jobs) {
      if (
        (job.status === JobStatus.COMPLETED ||
          job.status === JobStatus.FAILED ||
          job.status === JobStatus.CANCELLED) &&
        job.completedAt &&
        now - job.completedAt > 3600000
      ) {
        this.jobs.delete(jobId);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      this._persist();
      logger.debug('JobStore cleanup', { cleaned });
    }
  }

  _persist() {
    try {
      const data = {
        uploads: Array.from(this.uploads.values()),
        jobs: Array.from(this.jobs.values()),
        nextQueuePosition: this.nextQueuePosition,
        persistedAt: Date.now(),
      };
      fs.writeFileSync(this.persistPath, JSON.stringify(data, null, 2));
    } catch (err) {
      logger.warn('Failed to persist jobs', { error: err.message });
    }
  }

  _deleteUploadFile(upload) {
    try {
      if (upload.tempPath && fs.existsSync(upload.tempPath)) {
        fs.unlinkSync(upload.tempPath);
      }
    } catch (err) {
      logger.warn('Failed to delete upload file', { fileId: upload.fileId, error: err.message });
    }
  }

  // === Upload Management ===

  /**
   * Register a new upload.
   * @param {Object} opts
   * @param {string} opts.tempPath - Path to uploaded file
   * @param {string} opts.originalFilename - Client filename
   * @param {string} opts.detectedType - Detected media type
   * @param {string} opts.detectedMimeType - Detected MIME type
   * @param {number} opts.size - File size
   * @param {string} [opts.uploadId] - Optional idempotency key
   * @returns {UploadEntry}
   */
  registerUpload(opts) {
    // Check for idempotent retry
    if (opts.uploadId) {
      for (const upload of this.uploads.values()) {
        if (upload.uploadId === opts.uploadId && !upload.processed) {
          return upload;
        }
      }
    }

    const fileId = `upload-${uuidv4()}`;
    const now = Date.now();

    const upload = {
      fileId,
      uploadId: opts.uploadId || null,
      tempPath: opts.tempPath,
      originalFilename: this._sanitizeFilename(opts.originalFilename),
      detectedType: opts.detectedType,
      detectedMimeType: opts.detectedMimeType,
      size: opts.size,
      createdAt: now,
      expiresAt: now + this.uploadTTL,
      processed: false,
    };

    this.uploads.set(fileId, upload);
    this._persist();

    return upload;
  }

  /**
   * Get upload by ID.
   * @param {string} fileId
   * @returns {UploadEntry|null}
   */
  getUpload(fileId) {
    const upload = this.uploads.get(fileId);
    if (!upload) return null;

    if (Date.now() > upload.expiresAt && !upload.processed) {
      this._deleteUploadFile(upload);
      this.uploads.delete(fileId);
      return null;
    }

    return upload;
  }

  /**
   * Mark upload as processed (extends its lifetime).
   * @param {string} fileId
   */
  markUploadProcessed(fileId) {
    const upload = this.uploads.get(fileId);
    if (upload) {
      upload.processed = true;
      this._persist();
    }
  }

  /**
   * Delete an upload.
   * @param {string} fileId
   * @returns {boolean}
   */
  deleteUpload(fileId) {
    const upload = this.uploads.get(fileId);
    if (!upload) return false;

    this._deleteUploadFile(upload);
    this.uploads.delete(fileId);
    this._persist();
    return true;
  }

  // === Job Management ===

  /**
   * Create a new job.
   * @param {Object} opts
   * @param {string} [opts.fileId] - Upload ID (Pattern B)
   * @param {string} [opts.inputPath] - Source path (Pattern A)
   * @param {string} opts.processor - 'image', 'audio', or 'video'
   * @param {string} [opts.mode] - Processing mode
   * @param {Object} opts.options - Processing options
   * @returns {JobEntry}
   */
  createJob(opts) {
    const jobId = uuidv4();
    const now = Date.now();
    const queuePosition = this.nextQueuePosition++;

    const job = {
      jobId,
      fileId: opts.fileId || null,
      inputPath: opts.inputPath || null,
      processor: opts.processor,
      mode: opts.mode || null,
      options: opts.options || {},
      status: JobStatus.QUEUED,
      percent: 0,
      message: 'Queued',
      assetId: null,
      error: null,
      outputPath: opts.outputPath || null,
      deleted: false,
      createdAt: now,
      startedAt: null,
      completedAt: null,
      queuePosition,
    };

    this.jobs.set(jobId, job);

    if (opts.fileId) {
      this.uploadToJob.set(opts.fileId, jobId);
    }

    this._persist();
    return job;
  }

  /**
   * Get job by ID.
   * @param {string} jobId
   * @returns {JobEntry|null}
   */
  getJob(jobId) {
    return this.jobs.get(jobId) || null;
  }

  /**
   * Get job by upload ID.
   * @param {string} fileId
   * @returns {JobEntry|null}
   */
  getJobByUpload(fileId) {
    const jobId = this.uploadToJob.get(fileId);
    if (!jobId) return null;
    return this.jobs.get(jobId) || null;
  }

  /**
   * Update job status.
   * @param {string} jobId
   * @param {string} status
   * @param {Object} [extra] - Additional fields to update
   */
  updateJob(jobId, status, extra = {}) {
    const job = this.jobs.get(jobId);
    if (!job) return;

    job.status = status;

    if (status === JobStatus.PROCESSING && !job.startedAt) {
      job.startedAt = Date.now();
    }

    if (status === JobStatus.COMPLETED || status === JobStatus.FAILED || status === JobStatus.CANCELLED) {
      job.completedAt = Date.now();
    }

    Object.assign(job, extra);
    this._persist();
  }

  /**
   * Get queued jobs sorted by queue position.
   * @returns {JobEntry[]}
   */
  getQueuedJobs() {
    return Array.from(this.jobs.values())
      .filter(j => j.status === JobStatus.QUEUED)
      .sort((a, b) => a.queuePosition - b.queuePosition);
  }

  /**
   * Get all jobs.
   * @returns {JobEntry[]}
   */
  getAllJobs() {
    return Array.from(this.jobs.values());
  }

  /**
   * Delete a job.
   * @param {string} jobId
   * @returns {boolean}
   */
  deleteJob(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return false;

    if (job.fileId) {
      this.uploadToJob.delete(job.fileId);
    }

    this.jobs.delete(jobId);
    this._persist();
    return true;
  }

  /**
   * Get job statistics.
   * @returns {Object}
   */
  getStats() {
    const jobs = Array.from(this.jobs.values());
    return {
      total: jobs.length,
      queued: jobs.filter(j => j.status === JobStatus.QUEUED).length,
      processing: jobs.filter(j => j.status === JobStatus.PROCESSING).length,
      completed: jobs.filter(j => j.status === JobStatus.COMPLETED).length,
      failed: jobs.filter(j => j.status === JobStatus.FAILED).length,
      cancelled: jobs.filter(j => j.status === JobStatus.CANCELLED).length,
      uploads: this.uploads.size,
    };
  }

  _sanitizeFilename(filename) {
    if (!filename) return 'unknown';
    return filename.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').substring(0, 255);
  }
}

export const jobStore = new JobStore();
export default jobStore;
