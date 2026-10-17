import logger, { logError } from '../utils/logger.js';

/**
 * Executes a chain of processors in sequence
 */
class PipelineExecutor {
  constructor() {
    this.processors = new Map();
  }

  /**
   * Register a processor
   * @param {string} type - Processor type (image, audio, video)
   * @param {Processor} processor
   */
  register(type, processor) {
    this.processors.set(type, processor);
    logger.info(`Registered processor: ${type}`, {}, 'System', { console: true });
  }

  /**
   * Get a registered processor
   * @param {string} type
   * @returns {Processor|undefined}
   */
  get(type) {
    return this.processors.get(type);
  }

  /**
   * Execute a processor with progress reporting
   * @param {string} type - Processor type
   * @param {Buffer} input - Input buffer
   * @param {Object} options - Processor options
   * @param {Object} progressReporter - ProgressReporter instance
   * @param {string} jobId - Job ID for progress
   * @param {string} [requestId] - HTTP request ID for correlation
   * @returns {Promise<Object>} - { buffer, metadata }
   */
  async execute(type, input, options, progressReporter, jobId, requestId = null) {
    const processor = this.processors.get(type);
    if (!processor) {
      throw new Error(`Unknown processor type: ${type}`);
    }

    const inputSize = Buffer.isBuffer(input) ? input.length : null;

    logger.info(`Executing ${type} processor`, { jobId, requestId, inputSize, options });

    progressReporter.send(jobId, 'start', { processor: type });

    try {
      processor.validateOptions?.(options);

      const result = await processor.process(input, options, (percent, message) => {
        progressReporter.progress(jobId, percent, message);
      });

      progressReporter.complete(jobId, {
        metadata: result.metadata,
      });

      return result;
    } catch (error) {
      logError('Processor failed', error, {
        processor: type,
        jobId,
        requestId,
        inputSize,
        options,
      });
      progressReporter.error(jobId, error.message);
      throw error;
    }
  }
}

export default new PipelineExecutor();
