import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from '../utils/uuid.js';
import config from '../config/config.js';

/**
 * Custom multipart/form-data parser.
 * Streams file uploads directly to disk to avoid buffering large files in memory.
 * Uses Buffer operations for header parsing - no toString() on large buffers.
 */
export class MultipartParser {
  constructor(boundary) {
    this.boundary = boundary;
    this.boundaryMarker = Buffer.from(`--${boundary}`);
  }

  async parse(req) {
    return new Promise((resolve, reject) => {
      const parts = { fields: {}, files: [] };
      let state = 'boundary'; // boundary, headers, body
      let headerBuffer = Buffer.alloc(0);
      let currentHeaders = null;
      let currentField = null;
      let currentFile = null;
      let fileStream = null;
      let fileSize = 0;
      
      // Boundary detection state
      let potentialBoundaryStart = 0;
      let boundaryMatchPos = 0;

      const flushBoundary = Buffer.from('\r\n');

      req.on('data', (chunk) => {
        try {
          let offset = 0;
          
          while (offset < chunk.length) {
            if (state === 'boundary') {
              // Look for boundary marker
              const remaining = chunk.slice(offset);
              const idx = remaining.indexOf(this.boundaryMarker);
              
              if (idx === -1) {
                // No boundary found in this chunk, skip most of it
                // Keep last (boundaryMarker.length - 1) bytes for next chunk
                const keep = Math.min(remaining.length, this.boundaryMarker.length - 1);
                offset = chunk.length - keep;
                continue;
              }
              
              // Found boundary
              offset += idx + this.boundaryMarker.length;
              state = 'headers';
              headerBuffer = Buffer.alloc(0);
              continue;
            }
            
            if (state === 'headers') {
              // Accumulate header data until we find \r\n\r\n
              const remaining = chunk.slice(offset);
              const headerEnd = remaining.indexOf('\r\n\r\n');
              
              if (headerEnd === -1) {
                // Headers not complete yet
                headerBuffer = Buffer.concat([headerBuffer, remaining]);
                offset = chunk.length;
                continue;
              }
              
              // Headers complete
              headerBuffer = Buffer.concat([headerBuffer, remaining.slice(0, headerEnd)]);
              const headersStr = headerBuffer.toString('utf8');
              offset += headerEnd + 4;
              
              // Parse headers
              const nameMatch = headersStr.match(/name="([^"]+)"/);
              const filenameMatch = headersStr.match(/filename="([^"]+)"/);
              const contentTypeMatch = headersStr.match(/Content-Type:\s*([^\r\n]+)/i);
              
              currentField = nameMatch ? nameMatch[1] : null;
              const filename = filenameMatch ? filenameMatch[1] : null;
              const contentType = contentTypeMatch ? contentTypeMatch[1].trim() : 'application/octet-stream';
              
              if (filename) {
                // File upload - stream to disk
                const ext = path.extname(filename) || '.bin';
                const tempPath = path.join(config.cacheDir, `upload-${uuidv4()}${ext}`);
                fileStream = fs.createWriteStream(tempPath);
                currentFile = {
                  fieldname: currentField,
                  originalFilename: filename,
                  mimeType: contentType,
                  size: 0,
                  tempPath,
                };
                fileSize = 0;
              }
              
              state = 'body';
              continue;
            }
            
            if (state === 'body') {
              const remaining = chunk.slice(offset);
              
              if (currentFile && fileStream) {
                // Check if boundary appears in this chunk
                const boundaryIdx = remaining.indexOf(this.boundaryMarker);
                
                if (boundaryIdx !== -1) {
                  // End of file part
                  const fileData = remaining.slice(0, boundaryIdx);
                  // Remove trailing \r\n if present
                  let actualData = fileData;
                  if (fileData.length >= 2 && fileData[fileData.length - 2] === 13 && fileData[fileData.length - 1] === 10) {
                    actualData = fileData.slice(0, -2);
                  }
                  if (actualData.length > 0) {
                    fileStream.write(actualData);
                    fileSize += actualData.length;
                  }
                  fileStream.end();
                  currentFile.size = fileSize;
                  parts.files.push(currentFile);
                  
                  offset += boundaryIdx + this.boundaryMarker.length;
                  state = 'headers';
                  headerBuffer = Buffer.alloc(0);
                  currentFile = null;
                  fileStream = null;
                  continue;
                }
                
                // No boundary - write entire chunk to file
                fileStream.write(remaining);
                fileSize += remaining.length;
                offset = chunk.length;
                continue;
              } else if (currentField) {
                // Regular field - accumulate in buffer
                const boundaryIdx = remaining.indexOf(this.boundaryMarker);
                
                if (boundaryIdx !== -1) {
                  let fieldData = remaining.slice(0, boundaryIdx);
                  // Remove trailing \r\n
                  if (fieldData.length >= 2 && fieldData[fieldData.length - 2] === 13 && fieldData[fieldData.length - 1] === 10) {
                    fieldData = fieldData.slice(0, -2);
                  }
                  parts.fields[currentField] = fieldData.toString('utf8');
                  
                  offset += boundaryIdx + this.boundaryMarker.length;
                  state = 'headers';
                  headerBuffer = Buffer.alloc(0);
                  currentField = null;
                  continue;
                }
                
                offset = chunk.length;
                continue;
              }
            }
          }
        } catch (err) {
          reject(err);
        }
      });
      
      req.on('end', () => {
        try {
          if (fileStream) {
            fileStream.end();
            if (currentFile) {
              currentFile.size = fileSize;
              parts.files.push(currentFile);
            }
          }
          resolve(parts);
        } catch (err) {
          reject(err);
        }
      });
      
      req.on('error', reject);
    });
  }
}

export function extractBoundary(contentType) {
  if (!contentType) return null;
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (match) return (match[1] || match[2]).trim();
  return null;
}
