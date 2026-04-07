/**
 * Custom multipart/form-data parser.
 * Parses incoming request streams without external dependencies.
 */
export class MultipartParser {
  constructor(boundary) {
    this.boundary = boundary;
    this.boundaryMarker = `--${boundary}`;
    this.endMarker = `--${boundary}--`;
  }

  async parse(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      
      req.on('data', (chunk) => chunks.push(chunk));
      
      req.on('end', () => {
        try {
          const buffer = Buffer.concat(chunks);
          const result = this.parseBuffer(buffer);
          resolve(result);
        } catch (err) {
          reject(err);
        }
      });
      
      req.on('error', reject);
    });
  }

  parseBuffer(buffer) {
    const parts = { fields: {}, files: [] };
    const str = buffer.toString('binary');
    
    // Find all boundary positions
    const boundaries = [];
    let pos = 0;
    while (true) {
      const idx = str.indexOf(this.boundaryMarker, pos);
      if (idx === -1) break;
      boundaries.push(idx);
      pos = idx + this.boundaryMarker.length;
    }

    if (boundaries.length === 0) {
      return parts;
    }

    // Process each part between boundaries
    for (let i = 0; i < boundaries.length - 1; i++) {
      const start = boundaries[i] + this.boundaryMarker.length;
      const end = boundaries[i + 1];
      let partData = buffer.slice(start, end);
      
      // Remove leading CRLF if present
      if (partData.length >= 2 && partData[0] === 13 && partData[1] === 10) {
        partData = partData.slice(2);
      }
      
      // Remove trailing CRLF if present
      if (partData.length >= 2 && partData[partData.length - 2] === 13 && partData[partData.length - 1] === 10) {
        partData = partData.slice(0, -2);
      }
      
      // Remove trailing '--' if this was before end marker
      if (partData.length >= 2 && partData[partData.length - 2] === 45 && partData[partData.length - 1] === 45) {
        partData = partData.slice(0, -2);
      }

      // Parse headers and body
      const headerEnd = partData.indexOf('\r\n\r\n');
      if (headerEnd === -1) continue;

      const headersStr = partData.slice(0, headerEnd).toString('utf8');
      const body = partData.slice(headerEnd + 4);

      // Parse Content-Disposition
      const nameMatch = headersStr.match(/name="([^"]+)"/);
      const filenameMatch = headersStr.match(/filename="([^"]+)"/);
      const contentTypeMatch = headersStr.match(/Content-Type:\s*([^\r\n]+)/i);

      const name = nameMatch ? nameMatch[1] : null;
      const filename = filenameMatch ? filenameMatch[1] : null;
      const contentType = contentTypeMatch ? contentTypeMatch[1].trim() : 'application/octet-stream';

      if (filename) {
        parts.files.push({
          fieldname: name,
          originalFilename: filename,
          mimeType: contentType,
          buffer: body,
          size: body.length,
        });
      } else if (name) {
        parts.fields[name] = body.toString('utf8');
      }
    }

    return parts;
  }
}

export function extractBoundary(contentType) {
  if (!contentType) return null;
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (match) return (match[1] || match[2]).trim();
  return null;
}
