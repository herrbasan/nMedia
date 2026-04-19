/**
 * Media Service API Client
 * Handles communication with the Media Service backend
 */

const API_BASE = 'http://localhost:3501';

/**
 * Upload and process an image file
 * @param {File} file - The image file to process
 * @param {Object} options - Processing options
 * @returns {Promise<{success: boolean, data?: Object, error?: string}>}
 */
async function processImage(file, options = {}) {
    const formData = new FormData();
    formData.append('file', file);
    
    // Add options
    if (options.max_dimension) formData.append('max_dimension', options.max_dimension);
    if (options.quality) formData.append('quality', options.quality);
    if (options.format) formData.append('format', options.format);
    if (options.strip_exif !== undefined) formData.append('strip_exif', options.strip_exif);
    formData.append('response_type', 'base64');

    try {
        const response = await fetch(`${API_BASE}/v1/process/image`, {
            method: 'POST',
            body: formData
        });

        if (!response.ok) {
            const errorText = await response.text();
            return { success: false, error: `HTTP ${response.status}: ${errorText}` };
        }

        const data = await response.json();
        return { success: true, data };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

/**
 * Upload and process an audio file
 * @param {File} file - The audio file to process
 * @param {Object} options - Processing options
 * @returns {Promise<{success: boolean, data?: Object, error?: string}>}
 */
async function processAudio(file, options = {}) {
    const formData = new FormData();
    formData.append('file', file);
    
    // Add options
    if (options.sample_rate) formData.append('sample_rate', options.sample_rate);
    if (options.channels) formData.append('channels', options.channels);
    if (options.format) formData.append('format', options.format);
    formData.append('response_type', 'base64');

    try {
        const response = await fetch(`${API_BASE}/v1/process/audio`, {
            method: 'POST',
            body: formData
        });

        if (!response.ok) {
            const errorText = await response.text();
            return { success: false, error: `HTTP ${response.status}: ${errorText}` };
        }

        const data = await response.json();
        return { success: true, data };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

/**
 * Upload and process a video file
 * @param {File} file - The video file to process
 * @param {Object} options - Processing options
 * @returns {Promise<{success: boolean, data?: Object, error?: string}>}
 */
async function processVideo(file, options = {}) {
    const formData = new FormData();
    formData.append('file', file);
    
    // Add options
    if (options.mode) formData.append('mode', options.mode);
    if (options.fps) formData.append('fps', options.fps);
    if (options.max_dimension) formData.append('max_dimension', options.max_dimension);
    formData.append('response_type', 'base64');

    try {
        const response = await fetch(`${API_BASE}/v1/process/video`, {
            method: 'POST',
            body: formData
        });

        if (!response.ok) {
            const errorText = await response.text();
            return { success: false, error: `HTTP ${response.status}: ${errorText}` };
        }

        const data = await response.json();
        return { success: true, data };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

/**
 * Check if the Media Service is healthy
 * @returns {Promise<{healthy: boolean, error?: string}>}
 */
async function checkHealth() {
    try {
        const response = await fetch(`${API_BASE}/health`, { method: 'GET' });
        return { healthy: response.ok };
    } catch (error) {
        return { healthy: false, error: error.message };
    }
}

/**
 * Format file size for display
 * @param {number} bytes - Size in bytes
 * @returns {string} Formatted size string
 */
function formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Get MIME type from format extension
 * @param {string} format - Format extension (e.g., 'jpeg', 'png')
 * @param {string} type - 'image', 'audio', or 'video'
 * @returns {string} MIME type
 */
function getMimeType(format, type) {
    const mimeTypes = {
        image: {
            jpeg: 'image/jpeg',
            jpg: 'image/jpeg',
            png: 'image/png',
            webp: 'image/webp',
            avif: 'image/avif',
            gif: 'image/gif'
        },
        audio: {
            mp3: 'audio/mpeg',
            wav: 'audio/wav',
            ogg: 'audio/ogg',
            m4a: 'audio/mp4'
        }
    };
    
    return mimeTypes[type]?.[format] || `${type}/${format}`;
}

// Export for module usage
export { processImage, processAudio, processVideo, checkHealth, formatFileSize, getMimeType, API_BASE };
