import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from '../utils/uuid.js';
import config from '../config/config.js';
import logger from '../utils/logger.js';

/**
 * Streaming multipart/form-data parser.
 * Pipes request to temp file, then parses with boundary detection.
 * Uses \r\n-prefixed boundary search to avoid false matches in binary data.
 */
export class MultipartParser {
  constructor(boundary) {
    this.boundary = boundary;
  }

  async parse(req) {
    const parts = { fields: {}, files: [] };
    
    // Pipe entire request to temp file
    const tempPath = path.join(config.cacheDir, `multipart-${uuidv4()}.raw`);
    
    await new Promise((resolve, reject) => {
      const writeStream = fs.createWriteStream(tempPath);
      req.pipe(writeStream);
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
    });

    const fileSize = fs.statSync(tempPath).size;
    logger.info(`Multipart request piped to disk: ${fileSize} bytes`);
    
    try {
      return this._parseFile(tempPath, fileSize, parts);
    } finally {
      try { fs.unlinkSync(tempPath); } catch {}
    }
  }

  _parseFile(filePath, fileSize, parts) {
    const fd = fs.openSync(filePath, 'r');
    
    try {
      // Read first 2KB to find boundary and parse initial parts
      const headerBuf = this._readBuffer(fd, 0, Math.min(4096, fileSize));
      if (!headerBuf) return parts;
      
      // Find first boundary: --boundary
      const boundaryStr = `--${this.boundary}`;
      const firstBoundaryIdx = headerBuf.indexOf(boundaryStr);
      if (firstBoundaryIdx === -1) {
        logger.error('No boundary found in multipart request');
        return parts;
      }
      
      let pos = firstBoundaryIdx + boundaryStr.length;
      
      // Parse each part
      while (pos < fileSize - 100) {
        // Skip \r\n after boundary
        const afterBoundary = this._readBuffer(fd, pos, 2);
        if (afterBoundary && afterBoundary[0] === 13 && afterBoundary[1] === 10) {
          pos += 2;
        }
        
        // Read headers
        const headerChunk = this._readBuffer(fd, pos, 4096);
        if (!headerChunk) break;
        
        const headerEndIdx = headerChunk.indexOf('\r\n\r\n');
        if (headerEndIdx === -1) break;
        
        const headersStr = headerChunk.slice(0, headerEndIdx).toString('utf8');
        const bodyStart = pos + headerEndIdx + 4;
        
        // Parse headers
        const nameMatch = headersStr.match(/name="([^"]+)"/);
        const filenameMatch = headersStr.match(/filename="([^"]+)"/);
        const contentTypeMatch = headersStr.match(/Content-Type:\s*([^\r\n]+)/i);
        
        const name = nameMatch ? nameMatch[1] : null;
        const filename = filenameMatch ? filenameMatch[1] : null;
        const contentType = contentTypeMatch ? contentTypeMatch[1].trim() : 'application/octet-stream';
        
        // Check if this is the end boundary
        if (headersStr.includes(`--${this.boundary}--`)) {
          break;
        }
        
        // Find the next boundary by reading from the END of the file backwards
        // Read last 2KB to find the final boundary position
        // For file parts, the body ends at: fileSize - len(\r\n--boundary--\r\n)
        // For non-last parts, we need to find \r\n--boundary
        
        let bodyEnd;
        const endBoundaryStr = `\r\n--${this.boundary}`;

        // Find next boundary scanning forward
        let nextBoundaryPos = this._findInFile(fd, Buffer.from(endBoundaryStr), bodyStart, 1024 * 1024);
        if (nextBoundaryPos === -1) {
          bodyEnd = fileSize;
        } else {
          bodyEnd = nextBoundaryPos;
          // Remove trailing \r\n before boundary
          const trailingCheck = this._readBuffer(fd, bodyEnd - 2, 2);
          if (trailingCheck && trailingCheck[0] === 13 && trailingCheck[1] === 10) {
            bodyEnd -= 2;
          }
        }

        const bodyLength = bodyEnd - bodyStart;

        if (filename && bodyLength > 0) {
          // File part - extract to separate file
          const ext = path.extname(filename) || '.bin';
          const outputPath = path.join(config.cacheDir, `upload-${uuidv4()}${ext}`);
          
          this._copyFileRange(fd, bodyStart, bodyLength, outputPath);
          
          const exists = fs.existsSync(outputPath);
          const size = exists ? fs.statSync(outputPath).size : 0;
          logger.info(`Extracted file: ${filename} (${bodyLength} bytes) → ${outputPath} (exists: ${exists}, actual: ${size})`);
          
          parts.files.push({
            fieldname: name,
            originalFilename: filename,
            mimeType: contentType,
            size: bodyLength,
            tempPath: outputPath,
          });
        } else if (name && bodyLength > 0) {
          // Text field
          const fieldBuf = this._readBuffer(fd, bodyStart, Math.min(bodyLength, 65536));
          if (fieldBuf) {
            parts.fields[name] = fieldBuf.toString('utf8');
          }
        }
        
        // Move past this part's boundary
        
        
        nextBoundaryPos = this._findInFile(fd, Buffer.from(endBoundaryStr), bodyEnd, 1024*1024);
        if (nextBoundaryPos === -1) break;
        pos = nextBoundaryPos + endBoundaryStr.length;
        
        // Check for end boundary
        const afterPos = this._readBuffer(fd, pos, 2);
        if (afterPos && afterPos[0] === 45 && afterPos[1] === 45) break; // --
      }
    } finally {
      fs.closeSync(fd);
    }
    
    return parts;
  }

  _readBuffer(fd, offset, length) {
    if (length <= 0) return null;
    const buf = Buffer.alloc(length);
    try {
      const bytesRead = fs.readSync(fd, buf, 0, length, offset);
      return bytesRead > 0 ? buf.slice(0, bytesRead) : null;
    } catch {
      return null;
    }
  }

  _findInFile(fd, pattern, startOffset, chunkSize) {
    const searchBuf = Buffer.alloc(chunkSize);
    let pos = startOffset;
    let carryBuf = Buffer.alloc(0);
    let iterations = 0;
    const maxIterations = 100000; // Safety limit
    
    while (iterations < maxIterations) {
      iterations++;
      try {
        const bytesRead = fs.readSync(fd, searchBuf, 0, searchBuf.length, pos);
        if (bytesRead === 0) return -1;
        
        const data = bytesRead < searchBuf.length ? searchBuf.slice(0, bytesRead) : searchBuf;
        const combined = carryBuf.length > 0 ? Buffer.concat([carryBuf, data]) : data;
        
        const idx = combined.indexOf(pattern);
        if (idx !== -1) {
          return pos - carryBuf.length + idx;
        }
        
        const keep = Math.min(combined.length, pattern.length - 1);
        carryBuf = combined.slice(combined.length - keep);
        pos += bytesRead;
      } catch {
        return -1;
      }
    }
    return -1;
  }

  _copyFileRange(fd, offset, length, outputPath) {
    const CHUNK_SIZE = 16 * 1024 * 1024; // 16MB chunks
    const writeFd = fs.openSync(outputPath, 'w');
    let remaining = length;
    let readPos = offset;
    const readBuf = Buffer.alloc(Math.min(CHUNK_SIZE, length));
    
    try {
      while (remaining > 0) {
        const toRead = Math.min(CHUNK_SIZE, remaining);
        const bytesRead = fs.readSync(fd, readBuf, 0, toRead, readPos);
        if (bytesRead === 0) break;
        fs.writeSync(writeFd, readBuf, 0, bytesRead);
        remaining -= bytesRead;
        readPos += bytesRead;
      }
    } finally {
      fs.closeSync(writeFd);
    }
  }
}

export function extractBoundary(contentType) {
  if (!contentType) return null;
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (match) return (match[1] || match[2]).trim();
  return null;
}
