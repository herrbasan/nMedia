import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from '../utils/uuid.js';
import config from '../config/config.js';

/**
 * Streaming multipart/form-data parser.
 * Pipes the entire request to a temp file, then parses it.
 * Zero memory buffering - handles files of any size.
 */
export class MultipartParser {
  constructor(boundary) {
    this.boundary = `--${boundary}`;
    this.boundaryEnd = `--${boundary}--`;
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
    const fd = fs.openSync(tempPath, 'r');
    
    try {
      // Read file in chunks to find boundaries
      const boundaryBuf = Buffer.from(this.boundary);
      const boundaryEndBuf = Buffer.from(this.boundaryEnd);
      const CRLF = Buffer.from('\r\n');
      
      let pos = 0;
      
      // Find first boundary
      const firstBoundaryPos = this._findInFile(fd, boundaryBuf, pos, 8192);
      if (firstBoundaryPos === -1) {
        return parts;
      }
      pos = firstBoundaryPos + boundaryBuf.length;
      
      while (pos < fileSize) {
        // Skip CRLF after boundary
        const crlfCheck = this._readBuffer(fd, pos, 2);
        if (crlfCheck && crlfCheck[0] === 13 && crlfCheck[1] === 10) {
          pos += 2;
        }
        
        // Read headers (max 4KB should be enough)
        const headerBuf = this._readBuffer(fd, pos, 4096);
        if (!headerBuf) break;
        
        const headerEndIdx = headerBuf.indexOf('\r\n\r\n');
        if (headerEndIdx === -1) break;
        
        const headersStr = headerBuf.slice(0, headerEndIdx).toString('utf8');
        const headerBytes = headerEndIdx + 4;
        const bodyStart = pos + headerBytes;
        
        // Parse headers
        const nameMatch = headersStr.match(/name="([^"]+)"/);
        const filenameMatch = headersStr.match(/filename="([^"]+)"/);
        const contentTypeMatch = headersStr.match(/Content-Type:\s*([^\r\n]+)/i);
        
        const name = nameMatch ? nameMatch[1] : null;
        const filename = filenameMatch ? filenameMatch[1] : null;
        const contentType = contentTypeMatch ? contentTypeMatch[1].trim() : 'application/octet-stream';
        
        // Find next boundary
        const nextBoundaryPos = this._findInFile(fd, boundaryBuf, bodyStart, 8192);
        if (nextBoundaryPos === -1) break;
        
        // Body ends at next boundary, minus trailing CRLF
        let bodyEnd = nextBoundaryPos;
        if (bodyEnd >= bodyStart + 2) {
          const trailingCheck = this._readBuffer(fd, bodyEnd - 2, 2);
          if (trailingCheck && trailingCheck[0] === 13 && trailingCheck[1] === 10) {
            bodyEnd -= 2;
          }
        }
        
        const bodyLength = bodyEnd - bodyStart;
        
        if (filename) {
          // File part - extract to separate file
          const ext = path.extname(filename) || '.bin';
          const outputPath = path.join(config.cacheDir, `upload-${uuidv4()}${ext}`);
          
          this._copyFileRange(fd, bodyStart, bodyLength, outputPath);
          
          parts.files.push({
            fieldname: name,
            originalFilename: filename,
            mimeType: contentType,
            size: bodyLength,
            tempPath: outputPath,
          });
        } else if (name) {
          // Field part - read as string
          const fieldBuf = this._readBuffer(fd, bodyStart, bodyLength);
          if (fieldBuf) {
            parts.fields[name] = fieldBuf.toString('utf8');
          }
        }
        
        pos = nextBoundaryPos + boundaryBuf.length;
        
        // Check if this was the end boundary
        const endCheck = this._readBuffer(fd, pos, 2);
        if (endCheck && endCheck[0] === 45 && endCheck[1] === 45) {
          break; // -- at end means this was --boundary--
        }
      }
    } finally {
      fs.closeSync(fd);
      fs.unlinkSync(tempPath);
    }
    
    return parts;
  }

  _readBuffer(fd, offset, length) {
    if (length <= 0) return null;
    const buf = Buffer.alloc(length);
    const bytesRead = fs.readSync(fd, buf, 0, length, offset);
    return bytesRead > 0 ? buf.slice(0, bytesRead) : null;
  }

  _findInFile(fd, pattern, startOffset, chunkSize) {
    const searchBuf = Buffer.alloc(Math.min(chunkSize, 8192));
    let pos = startOffset;
    let carryBuf = Buffer.alloc(0);
    
    while (true) {
      const bytesRead = fs.readSync(fd, searchBuf, 0, searchBuf.length, pos);
      if (bytesRead === 0) return -1;
      
      const data = bytesRead < searchBuf.length ? searchBuf.slice(0, bytesRead) : searchBuf;
      const combined = carryBuf.length > 0 ? Buffer.concat([carryBuf, data]) : data;
      
      const idx = combined.indexOf(pattern);
      if (idx !== -1) {
        return pos - carryBuf.length + idx;
      }
      
      // Keep last (pattern.length - 1) bytes for next iteration
      const keep = Math.min(combined.length, pattern.length - 1);
      carryBuf = combined.slice(combined.length - keep);
      pos += bytesRead;
    }
  }

  _copyFileRange(fd, offset, length, outputPath) {
    const readStream = fs.createReadStream(null, { fd, start: offset, end: offset + length - 1, autoClose: false });
    const writeStream = fs.createWriteStream(outputPath);
    readStream.pipe(writeStream);
    return new Promise((resolve, reject) => {
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
    });
  }
}

export function extractBoundary(contentType) {
  if (!contentType) return null;
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (match) return (match[1] || match[2]).trim();
  return null;
}
