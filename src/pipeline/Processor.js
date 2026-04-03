/**
 * Base Processor class - all media processors extend this
 */
class Processor {
  constructor(name) {
    this.name = name;
  }

  /**
   * Process the input buffer
   * @param {Buffer} input - Input buffer
   * @param {Object} options - Processor-specific options
   * @param {Function} onProgress - Callback for progress updates (0-100)
   * @returns {Promise<Object>} - { buffer, metadata }
   */
  async process(input, options, onProgress) {
    throw new Error('process() must be implemented by subclass');
  }

  /**
   * Validate options specific to this processor
   * @param {Object} options
   * @throws {Error} If options are invalid
   */
  validateOptions(options) {
    // Override in subclass
  }
}

export default Processor;
