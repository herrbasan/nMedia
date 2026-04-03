import { Writable } from 'stream';

/**
 * Custom multipart/form-data parser.
 * Parses incoming request streams without external dependencies.
 *
 * @example
 * const parser = new MultipartParser(boundary);
 * const parts = await parser.parse(req);
 * // parts = { fields: { name: 'value' }, files: [{ name, buffer, size }] }
 */
export class MultipartParser {
  /**
   * @param {string} boundary - Multipart boundary from Content-Type
   */
  constructor(boundary) {
    this.boundary = `--${boundary}`;
    this.boundaryEnd = `${this.boundary}--`;
  }

  /**
   * Parse a request stream into fields and files.
   * @param {http.IncomingMessage} req - Node.js request stream
   * @returns {Promise<{fields: Object, files: Array}>}
   */
  async parse(req) {
    return new Promise((resolve, reject) => {
      const parts = { fields: {}, files: [] };
      let currentPart = null;
      let headersBuffer = null;
      let bodyBuffer = null;
      let isReadingHeaders = false;
      let isReadingBody = false;
      let partName = null;
      let partFilename = null;
      let partContentType = null;

      // Find boundary in buffer
      const findBoundary = (buf, start = 0) => {
        const idx = buf.indexOf(this.boundary, start);
        if (idx !== -1) return idx;
        const endIdx = buf.indexOf(this.boundaryEnd, start);
        return endIdx !== -1 ? endIdx : -1;
      };

      // Check if we have complete headers (ends with \r\n\r\n)
      const hasCompleteHeaders = (buf) => {
        return buf.includes('\r\n\r\n');
      };

      // Parse headers from buffer
      const parseHeaders = (buf) => {
        const str = buf.toString('utf8');
        const headers = {};
        const lines = str.split('\r\n');
        for (const line of lines) {
          const idx = line.indexOf(': ');
          if (idx !== -1) {
            headers[line.slice(0, idx).toLowerCase()] = line.slice(idx + 2);
          }
        }
        return headers;
      };

      // Process accumulated data
      const processData = (data) => {
        let buffer = data;

        while (buffer.length > 0) {
          if (!currentPart) {
            // Looking for start of first part
            const idx = buffer.indexOf(this.boundary);
            if (idx === -1) {
              // No boundary yet, check for -- prefix
              if (buffer.slice(0, 2).toString() === '--') {
                buffer = buffer.slice(2);
              }
              break;
            }

            // Skip boundary line and CRLF
            const afterBoundary = buffer.slice(idx + this.boundary.length);
            if (afterBoundary.slice(0, 2).toString() === '--') {
              // End boundary
              resolve(parts);
              return;
            }
            const skipLen = afterBoundary[0] === 10 ? 1 : 0; // \n
            const skipLen2 = afterBoundary[skipLen] === 13 ? skipLen + 1 : skipLen; // \r
            buffer = afterBoundary.slice(skipLen2 + 1); // +1 for \n after CRLF

            currentPart = { start: Date.now() };
            headersBuffer = Buffer.alloc(0);
            isReadingHeaders = true;
            isReadingBody = false;
            continue;
          }

          if (isReadingHeaders) {
            const headerEndIdx = buffer.indexOf('\r\n\r\n');
            if (headerEndIdx === -1) {
              headersBuffer = Buffer.concat([headersBuffer, buffer]);
              break;
            }

            headersBuffer = Buffer.concat([headersBuffer, buffer.slice(0, headerEndIdx)]);
            const headers = parseHeaders(headersBuffer);

            // Parse Content-Disposition header
            const contentDisposition = headers['content-disposition'] || '';
            const nameMatch = contentDisposition.match(/name="([^"]+)"/);
            const filenameMatch = contentDisposition.match(/filename="([^"]+)"/);

            partName = nameMatch ? nameMatch[1] : null;
            partFilename = filenameMatch ? filenameMatch[1] : null;
            partContentType = headers['content-type'] || 'application/octet-stream';

            buffer = buffer.slice(headerEndIdx + 4); // Skip \r\n\r\n
            isReadingHeaders = false;

            if (partFilename) {
              // It's a file - collect body until next boundary
              isReadingBody = true;
              bodyBuffer = Buffer.alloc(0);
            } else {
              // It's a field - read until boundary
              isReadingBody = true;
              bodyBuffer = Buffer.alloc(0);
            }
            continue;
          }

          if (isReadingBody) {
            // Look for boundary in current buffer
            const boundaryIdx = findBoundary(buffer);

            if (boundaryIdx === -1) {
              // No boundary found, accumulate
              bodyBuffer = Buffer.concat([bodyBuffer, buffer]);
              break;
            }

            // Found boundary
            const beforeBoundary = buffer.slice(0, boundaryIdx);
            // Remove trailing CRLF before boundary
            const trailingCrlf = beforeBoundary.slice(-2).toString() === '\r\n';
            const endLen = trailingCrlf ? 2 : 0;
            bodyBuffer = Buffer.concat([bodyBuffer, beforeBoundary.slice(0, beforeBoundary.length - endLen)]);

            // Process completed part
            if (partFilename) {
              parts.files.push({
                fieldname: partName,
                originalFilename: partFilename,
                mimeType: partContentType,
                buffer: bodyBuffer,
                size: bodyBuffer.length,
              });
            } else if (partName) {
              parts.fields[partName] = bodyBuffer.toString('utf8');
            }

            // Check if this was end boundary
            const remaining = buffer.slice(boundaryIdx + this.boundary.length);
            if (remaining.slice(0, 2).toString() === '--') {
              resolve(parts);
              return;
            }

            // Prepare for next part
            currentPart = null;
            buffer = buffer.slice(boundaryIdx + this.boundary.length + 1); // Skip \n
          }
        }
      };

      req.on('data', (chunk) => {
        try {
          processData(chunk);
        } catch (err) {
          reject(err);
        }
      });

      req.on('end', () => {
        resolve(parts);
      });

      req.on('error', (err) => {
        reject(err);
      });
    });
  }
}

/**
 * Extract boundary from Content-Type header.
 * @param {string} contentType - Full Content-Type header value
 * @returns {string|null} - Boundary string or null if not found
 */
export function extractBoundary(contentType) {
  if (!contentType) return null;
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/);
  if (match) return match[1] || match[2];
  return null;
}